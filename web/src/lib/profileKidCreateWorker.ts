import { exclusive } from './exclusive';
import { validateStoredProfileDirectory, type ProfileDirectoryDocument } from './profileDirectory';
import {
  profilesApplyCreate,
  profilesCreateNext,
  profilesMaterialize,
  type ProfileCreateJournal,
} from './profilesCore';
import type { Stamp } from './wire';

export type ProfileCreateState =
  | 'journaled'
  | 'library-created'
  | 'ready'
  | 'committed'
  | 'conflict'
  | 'cas-unknown'
  | 'cancelling'
  | 'active';

interface DurableProfileCreate {
  readonly version: 1;
  readonly householdId: string;
  readonly request: ProfileCreateRequest;
  readonly state: ProfileCreateState;
  readonly journal: ProfileCreateJournal;
  readonly candidate?: ProfileDirectoryDocument;
  readonly authority?: ProfileDirectoryAuthority;
  readonly candidateRetired?: boolean;
}

interface ProfileCreateRequest {
  readonly operationId: string;
  readonly name: string;
  readonly maximumAge: number;
}

interface ProfileCreateReceipt {
  readonly request: ProfileCreateRequest;
  readonly result: ProfileKidCreateResult;
  /** Digest of the exact committed directory. No profile key is retained after completion. */
  readonly directoryDigest: string;
}

interface ProfileCreateEnvelope {
  readonly version: 1;
  readonly householdId: string;
  readonly pending?: DurableProfileCreate;
  /** At most one result may wait for the service supervisor's explicit acknowledgement. */
  readonly terminal?: ProfileCreateReceipt;
  /** Bounded tombstones stop a delayed, already-acknowledged operation from allocating again. */
  readonly settled: readonly ProfileCreateReceipt[];
}

export interface ProfileDirectoryAuthority {
  readonly base: number;
  readonly generation: string;
}

export interface ProfileKidCreateVault {
  readonly libraryId: string;
  keepRequired(name: string, value: unknown, binding?: string): Promise<void>;
  keptRequired<T>(
    name: string,
    binding?: string,
  ): Promise<{ readonly kind: 'absent' } | { readonly kind: 'value'; readonly value: T }>;
  discardKept(name: string): Promise<void>;
}

export interface ProfileKidCreateIO {
  hasActiveOwner(): boolean;
  readDirectory(): Promise<{
    readonly directory: ProfileDirectoryDocument;
    readonly authority: ProfileDirectoryAuthority;
  }>;
  createAndVerifyProfileLibrary(journal: ProfileCreateJournal): Promise<void>;
  casDirectory(
    authority: ProfileDirectoryAuthority,
    directory: ProfileDirectoryDocument,
  ): Promise<'committed' | 'conflict' | 'unknown'>;
  retireProfileLibrary(journal: ProfileCreateJournal): Promise<boolean>;
  adoptDirectory(directory: ProfileDirectoryDocument): Promise<void>;
  proveProfileResult(result: ProfileKidCreateResult): Promise<void>;
}

export interface ProfileKidCreateResult {
  readonly profile: string;
  readonly name: string;
  readonly maximumAge: number;
}

const ID = /^[0-9a-f]{32}$/;
const ACTOR = /^[0-9a-f]{16}$/;
const KEY = /^(?:[A-Za-z0-9+/]{43}=)$/;
const DIGEST = /^[0-9a-f]{64}$/;

/** Household-key-sealed crash journal. The profile key never crosses the Worker protocol. */
export class ProfileKidCreateStore {
  constructor(private readonly vault: ProfileKidCreateVault) {
    if (!ID.test(vault.libraryId)) throw new TypeError('Household identity is not canonical');
  }

  async create(
    operationId: string,
    name: string,
    maximumAge: number,
    stamps: readonly [Stamp, Stamp, Stamp, Stamp],
  ): Promise<
    | { readonly kind: 'pending'; readonly value: DurableProfileCreate }
    | { readonly kind: 'receipt'; readonly value: ProfileCreateReceipt }
  > {
    const request = checkedRequest({ operationId, name: name.trim(), maximumAge });
    const envelope = await this.envelope();
    const receipt = [...(envelope.terminal ? [envelope.terminal] : []), ...envelope.settled].find(
      ({ request: prior }) => prior.operationId === operationId,
    );
    if (receipt) {
      if (!sameRequest(receipt.request, request))
        throw new Error('Profile operation payload changed');
      return { kind: 'receipt', value: receipt };
    }
    if (envelope.terminal)
      throw new Error('A completed Kid profile creation is awaiting acknowledgement');
    if (envelope.pending) {
      if (!sameRequest(envelope.pending.request, request))
        throw new Error('Another Kid profile creation is already pending');
      return { kind: 'pending', value: envelope.pending };
    }
    if (!Number.isInteger(maximumAge) || maximumAge < 0 || maximumAge > 18)
      throw new TypeError('Kid maximum age must be between 0 and 18');
    const profile = randomHex(16);
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const journal: ProfileCreateJournal = {
      version: 1,
      profile,
      key: toBase64(raw),
      display: { value: { name: request.name }, at: stamps[0] },
      libraryAt: stamps[1],
      maximumAge,
      policyAt: stamps[2],
      deletedAt: stamps[3],
    };
    raw.fill(0);
    const effect = profilesCreateNext({ state: 'idle', explicitIntent: true, journal });
    if (effect.effect !== 'persist-journal')
      throw new Error('den-core refused Kid creation intent');
    const value: DurableProfileCreate = {
      version: 1,
      householdId: this.vault.libraryId,
      request,
      state: 'journaled',
      journal,
    };
    await this.write({ ...envelope, pending: value });
    return { kind: 'pending', value };
  }

  async load(): Promise<DurableProfileCreate | null> {
    return (await this.envelope()).pending ?? null;
  }

  async save(value: DurableProfileCreate): Promise<void> {
    checkedDurable(value, this.vault.libraryId);
    const envelope = await this.envelope();
    if (envelope.pending?.request.operationId !== value.request.operationId)
      throw new Error('Kid creation journal changed');
    await this.write({ ...envelope, pending: value });
  }

  async complete(value: DurableProfileCreate): Promise<ProfileCreateReceipt> {
    if (!value.candidate) throw new Error('Kid creation has no directory-bound receipt proof');
    const envelope = await this.envelope();
    if (envelope.pending?.request.operationId !== value.request.operationId)
      throw new Error('Kid creation journal changed before completion');
    const receipt: ProfileCreateReceipt = {
      request: value.request,
      result: publicResult(value.journal),
      directoryDigest: await sha256(profilesMaterialize(value.candidate).jcs),
    };
    await this.write({
      ...envelope,
      pending: undefined,
      terminal: receipt,
    });
    return receipt;
  }

  async acknowledge(operationId: string): Promise<void> {
    const envelope = await this.envelope();
    if (envelope.settled.some(({ request }) => request.operationId === operationId)) return;
    if (envelope.terminal?.request.operationId !== operationId)
      throw new Error('Kid creation receipt is unavailable');
    await this.write({
      ...envelope,
      terminal: undefined,
      settled: [...envelope.settled, envelope.terminal],
    });
  }

  async receipt(): Promise<ProfileCreateReceipt | null> {
    return (await this.envelope()).terminal ?? null;
  }

  async acknowledgement(operationId: string): Promise<ProfileKidCreateResult | null> {
    const envelope = await this.envelope();
    if (envelope.settled.some(({ request }) => request.operationId === operationId)) return null;
    if (envelope.terminal?.request.operationId !== operationId)
      throw new Error('Kid creation receipt is unavailable');
    return envelope.terminal.result;
  }

  private async envelope(): Promise<ProfileCreateEnvelope> {
    const opened = await this.vault.keptRequired<unknown>(this.name(), this.binding());
    if (opened.kind === 'absent')
      return { version: 1, householdId: this.vault.libraryId, settled: [] };
    return checkedEnvelope(opened.value, this.vault.libraryId);
  }

  private async write(value: ProfileCreateEnvelope): Promise<void> {
    checkedEnvelope(value, this.vault.libraryId);
    await this.vault.keepRequired(this.name(), value, this.binding());
  }

  private name(): string {
    return 'profile-create/v1/state';
  }

  private binding(): string {
    return `profile-create:${this.vault.libraryId}:1`;
  }
}

/** Runs only from an explicit Owner task, or resumes an already durable explicit journal. */
export class ProfileKidCreateCoordinator {
  constructor(
    private readonly householdId: string,
    private readonly store: ProfileKidCreateStore,
    private readonly io: ProfileKidCreateIO,
  ) {}

  begin(
    operationId: string,
    name: string,
    maximumAge: number,
    stamps: readonly [Stamp, Stamp, Stamp, Stamp],
  ): Promise<ProfileKidCreateReceipt> {
    return this.locked(async () => {
      // This is the authenticated directory already projected by the household Worker. Persist the explicit
      // intent before any network I/O; the fresh directory read that supplies CAS authority happens afterwards.
      if (!this.io.hasActiveOwner())
        throw new Error('Profile creation requires an active profile directory');
      const started = await this.store.create(operationId, name, maximumAge, stamps);
      if (started.kind === 'receipt') {
        await this.io.proveProfileResult(started.value.result);
        return publicReceipt(started.value);
      }
      return this.run();
    });
  }

  resume(): Promise<ProfileKidCreateReceipt | null> {
    return this.locked(async () => {
      const terminal = await this.store.receipt();
      if (terminal) {
        await this.io.proveProfileResult(terminal.result);
        return publicReceipt(terminal);
      }
      return (await this.store.load()) === null ? null : this.run();
    });
  }

  acknowledge(operationId: string): Promise<void> {
    return this.locked(async () => {
      const result = await this.store.acknowledgement(operationId);
      if (result) await this.io.proveProfileResult(result);
      await this.store.acknowledge(operationId);
    });
  }

  private async run(): Promise<ProfileKidCreateReceipt> {
    let fresh:
      | {
          readonly directory: ProfileDirectoryDocument;
          readonly authority: ProfileDirectoryAuthority;
        }
      | undefined;
    for (let step = 0; step < 32; step += 1) {
      const durable = await this.store.load();
      if (durable === null) throw new Error('Kid creation journal disappeared');
      const effect = profilesCreateNext({
        state: durable.state,
        journal: durable.journal,
        ...(durable.candidate ? { candidate: durable.candidate } : {}),
        ...(durable.authority ? { authority: durable.authority } : {}),
        ...(fresh
          ? { householdFresh: true, current: fresh.directory, authority: fresh.authority }
          : { householdFresh: false }),
        ...(durable.candidateRetired ? { candidateRetired: true } : {}),
      });
      switch (effect.effect) {
        case 'create-profile-library':
          await this.io.createAndVerifyProfileLibrary(durable.journal);
          await this.store.save({ ...durable, state: 'library-created' });
          break;
        case 'apply-create': {
          fresh = await this.io.readDirectory();
          const candidate = profilesApplyCreate({
            document: fresh.directory,
            profile: effect.profile,
            entry: effect.entry,
          });
          await this.store.save({
            ...durable,
            state: 'ready',
            candidate,
            authority: fresh.authority,
          });
          fresh = undefined;
          break;
        }
        case 'cas-directory': {
          const outcome = await this.io.casDirectory(
            { base: effect.base, generation: effect.generation },
            effect.directory as ProfileDirectoryDocument,
          );
          await this.store.save({
            ...durable,
            state: outcome === 'unknown' ? 'cas-unknown' : outcome,
          });
          fresh = undefined;
          break;
        }
        case 'read-directory':
          fresh = await this.io.readDirectory();
          break;
        case 'retire-profile-library':
          if (!(await this.io.retireProfileLibrary(durable.journal)))
            throw new Error('Kid candidate library retirement is not yet confirmed');
          await this.store.save({ ...durable, candidateRetired: true });
          break;
        case 'adopt':
          await this.io.adoptDirectory(effect.directory as ProfileDirectoryDocument);
          await this.store.save({ ...durable, state: 'active' });
          fresh = undefined;
          break;
        case 'discard-journal': {
          return publicReceipt(await this.store.complete(durable));
        }
        case 'no-op':
        case 'persist-journal':
          throw new Error(`Unexpected Kid creation effect: ${effect.effect}`);
      }
    }
    throw new Error('Kid profile creation did not converge');
  }

  private locked<T>(work: () => Promise<T>): Promise<T> {
    return exclusive(`den.profileCreate.${this.householdId}`, work);
  }
}

export interface ProfileKidCreateReceipt extends ProfileKidCreateResult {
  readonly receipt: string;
}

function publicReceipt(receipt: ProfileCreateReceipt): ProfileKidCreateReceipt {
  return { ...receipt.result, receipt: receipt.request.operationId };
}

function publicResult(journal: ProfileCreateJournal): ProfileKidCreateResult {
  return {
    profile: journal.profile,
    name: journal.display.value.name,
    maximumAge: journal.maximumAge,
  };
}

function checkedDurable(value: unknown, householdId: string): DurableProfileCreate {
  if (!record(value) || value.version !== 1 || value.householdId !== householdId)
    throw new Error('Kid creation journal is unavailable or corrupt');
  if (
    ![
      'journaled',
      'library-created',
      'ready',
      'committed',
      'conflict',
      'cas-unknown',
      'cancelling',
      'active',
    ].includes(String(value.state))
  )
    throw new Error('Kid creation journal is unavailable or corrupt');
  checkedRequest(value.request);
  const journal = value.journal;
  if (
    !record(journal) ||
    journal.version !== 1 ||
    typeof journal.profile !== 'string' ||
    !ID.test(journal.profile) ||
    typeof journal.key !== 'string' ||
    !KEY.test(journal.key) ||
    !record(journal.display) ||
    !record(journal.display.value) ||
    typeof journal.display.value.name !== 'string' ||
    !sameRequest(value.request as unknown as ProfileCreateRequest, {
      operationId: (value.request as unknown as ProfileCreateRequest).operationId,
      name: journal.display.value.name,
      maximumAge: journal.maximumAge as number,
    }) ||
    !Number.isInteger(journal.maximumAge) ||
    (journal.maximumAge as number) < 0 ||
    (journal.maximumAge as number) > 18 ||
    !stamp(journal.display.at) ||
    !stamp(journal.libraryAt) ||
    !stamp(journal.policyAt) ||
    !stamp(journal.deletedAt)
  )
    throw new Error('Kid creation journal is unavailable or corrupt');
  if (value.candidate !== undefined) validateStoredProfileDirectory(value.candidate);
  return value as unknown as DurableProfileCreate;
}

function checkedEnvelope(value: unknown, householdId: string): ProfileCreateEnvelope {
  if (
    !record(value) ||
    value.version !== 1 ||
    value.householdId !== householdId ||
    !Array.isArray(value.settled)
  )
    throw new Error('Kid creation state is unavailable or corrupt');
  const pending =
    value.pending === undefined ? undefined : checkedDurable(value.pending, householdId);
  const operations = new Set<string>();
  const profiles = new Set<string>();
  const checkedReceipt = (candidate: unknown): ProfileCreateReceipt => {
    if (!record(candidate)) throw new Error('Kid creation receipt is unavailable or corrupt');
    const request = checkedRequest(candidate.request);
    if (operations.has(request.operationId)) throw new Error('Kid creation receipt is duplicated');
    operations.add(request.operationId);
    const result = checkedResult(candidate.result);
    if (profiles.has(result.profile)) throw new Error('Kid creation profile receipt is duplicated');
    profiles.add(result.profile);
    if (
      result.name !== request.name ||
      result.maximumAge !== request.maximumAge ||
      typeof candidate.directoryDigest !== 'string' ||
      !DIGEST.test(candidate.directoryDigest)
    )
      throw new Error('Kid creation receipt does not match its request');
    return { request, result, directoryDigest: candidate.directoryDigest };
  };
  const terminal = value.terminal === undefined ? undefined : checkedReceipt(value.terminal);
  const settled = value.settled.map(checkedReceipt);
  if (
    pending &&
    (operations.has(pending.request.operationId) || profiles.has(pending.journal.profile))
  )
    throw new Error('Kid creation operation is both pending and complete');
  return {
    version: 1,
    householdId,
    ...(pending ? { pending } : {}),
    ...(terminal ? { terminal } : {}),
    settled,
  };
}

function checkedRequest(value: unknown): ProfileCreateRequest {
  if (!record(value)) throw new TypeError('Kid profile request is invalid');
  const operationId = value.operationId;
  const name = value.name;
  const maximumAge = value.maximumAge;
  if (
    typeof operationId !== 'string' ||
    !operationId ||
    operationId.length > 256 ||
    typeof name !== 'string' ||
    name !== name.trim() ||
    !name ||
    [...name].length > 64 ||
    !Number.isInteger(maximumAge) ||
    (maximumAge as number) < 0 ||
    (maximumAge as number) > 18
  )
    throw new TypeError('Kid profile request is invalid');
  return { operationId, name, maximumAge: maximumAge as number };
}

function checkedResult(value: unknown): ProfileKidCreateResult {
  if (
    !record(value) ||
    typeof value.profile !== 'string' ||
    !ID.test(value.profile) ||
    typeof value.name !== 'string' ||
    !Number.isInteger(value.maximumAge)
  )
    throw new Error('Kid creation receipt is unavailable or corrupt');
  return value as unknown as ProfileKidCreateResult;
}

function sameRequest(left: ProfileCreateRequest, right: ProfileCreateRequest): boolean {
  return (
    left.operationId === right.operationId &&
    left.name === right.name &&
    left.maximumAge === right.maximumAge
  );
}

function stamp(value: unknown): value is Stamp {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    Number.isSafeInteger(value[0]) &&
    (value[0] as number) >= 0 &&
    Number.isSafeInteger(value[1]) &&
    (value[1] as number) >= 0 &&
    typeof value[2] === 'string' &&
    ACTOR.test(value[2])
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}

function toBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
