import { profileMigrationAuthorizationFingerprint } from './profileMigrationCore';
import {
  checkedOwnerSplitJournal,
  type OwnerSplitCommitAuthorization,
  type OwnerSplitJournal,
  type OwnerSplitJournalStore,
  type OwnerSplitRecoveryIntent,
} from './profileOwnerSplitCoordinator';
import type { OwnerSplitCandidateHandle } from './profileOwnerSplitEngine';
import { exclusive } from './exclusive';
import { deriveKeys } from './wire';

const ID = /^[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const KEY_REF = /^[0-9a-f]{64}$/;
const ATTEMPT = ID;
const CANDIDATE_VERSION = 1;

/** The only persistence operations the migration adapter may use. LibraryLog seals both with its household key. */
export interface OwnerSplitWorkerVault {
  readonly libraryId: string;
  keepRequired(name: string, value: unknown, binding?: string): Promise<void>;
  keptRequired<T>(
    name: string,
    binding?: string,
  ): Promise<{ readonly kind: 'absent' } | { readonly kind: 'value'; readonly value: T }>;
  discardKept(name: string): Promise<void>;
}

interface SealedCandidateCredential {
  readonly version: 1;
  readonly householdId: string;
  readonly attempt: string;
  readonly keyVersion: 1;
  readonly keyRef: string;
  readonly profileId: string;
  readonly libraryId: string;
  readonly keyFingerprint: string;
  readonly createdAt: number;
  /** Base64 is inside the household-authenticated AES-GCM envelope, never a plain Vault value or page message. */
  readonly libraryKey: string;
}

interface DurableOwnerSplitState {
  readonly version: 1;
  readonly householdId: string;
  readonly journal: OwnerSplitJournal;
  readonly authorization?: OwnerSplitCommitAuthorization;
  readonly recovery?: OwnerSplitRecoveryIntent;
}

export interface ResolvedOwnerSplitCandidate {
  readonly handle: OwnerSplitCandidateHandle;
  readonly libraryKey: string;
  readonly token: string;
  readonly member: string;
  readonly createdAt: number;
}

/**
 * Worker-only durable state. The candidate secret is sealed by LibraryLog's non-extractable household-derived key;
 * public handles contain only random references and fingerprints. Every read rechecks household and attempt binding.
 */
export class OwnerSplitWorkerStore implements OwnerSplitJournalStore {
  readonly #vault: OwnerSplitWorkerVault;

  constructor(vault: OwnerSplitWorkerVault) {
    if (!ID.test(vault.libraryId)) throw new TypeError('Household identity is not canonical');
    this.#vault = vault;
  }

  async allocateCandidate(attempt: string): Promise<OwnerSplitCandidateHandle> {
    checkedAttempt(attempt);
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const keys = await deriveKeys(raw);
    const keyRef = randomHex(32);
    const profileId = randomHex(16);
    const keyFingerprint = profileMigrationAuthorizationFingerprint({
      token: keys.token,
      member: keys.member,
    }).tokenHash;
    const record: SealedCandidateCredential = {
      version: CANDIDATE_VERSION,
      householdId: this.#vault.libraryId,
      attempt,
      keyVersion: CANDIDATE_VERSION,
      keyRef,
      profileId,
      libraryId: keys.id,
      keyFingerprint,
      createdAt: Date.now(),
      libraryKey: toBase64(raw),
    };
    raw.fill(0);
    await this.#vault.keepRequired(
      this.#candidateName(keyRef),
      record,
      this.#candidateBinding(attempt),
    );
    // A best-effort browser store is not sufficient for a migration credential. Prove the encrypted value is
    // readable before revealing even its opaque handle to the lifecycle planner.
    await this.resolveCandidate(keyRef, attempt);
    return publicHandle(record);
  }

  async resolveCandidate(keyRef: string, attempt: string): Promise<ResolvedOwnerSplitCandidate> {
    checkedAttempt(attempt);
    if (!KEY_REF.test(keyRef)) throw new Error('Candidate secure reference is invalid');
    const opened = await this.#vault.keptRequired<unknown>(
      this.#candidateName(keyRef),
      this.#candidateBinding(attempt),
    );
    if (opened.kind === 'absent') throw new Error('Candidate credential is unavailable or corrupt');
    const record = checkedCandidateCredential(opened.value);
    if (
      record.householdId !== this.#vault.libraryId ||
      record.attempt !== attempt ||
      record.keyRef !== keyRef
    )
      throw new Error('Candidate secure reference is not bound to this household and attempt');
    const raw = fromBase64(record.libraryKey);
    if (raw === null || raw.length !== 32) throw new Error('Candidate credential is corrupt');
    try {
      const keys = await deriveKeys(raw);
      const fingerprint = profileMigrationAuthorizationFingerprint({
        token: keys.token,
        member: keys.member,
      }).tokenHash;
      if (keys.id !== record.libraryId || fingerprint !== record.keyFingerprint)
        throw new Error('Candidate credential does not match its public handle');
      return {
        handle: publicHandle(record),
        libraryKey: record.libraryKey,
        token: keys.token,
        member: keys.member,
        createdAt: record.createdAt,
      };
    } finally {
      raw.fill(0);
    }
  }

  async forgetCandidate(keyRef: string): Promise<void> {
    if (!KEY_REF.test(keyRef)) throw new Error('Candidate secure reference is invalid');
    await this.#vault.discardKept(this.#candidateName(keyRef));
  }

  async load(): Promise<OwnerSplitJournal | null> {
    return (await this.#state())?.journal ?? null;
  }

  async save(journal: OwnerSplitJournal): Promise<void> {
    const checked = checkedOwnerSplitJournal(journal);
    if (checked === null) throw new Error('Owner split journal is absent');
    await this.#locked(async () => {
      const current = await this.#state();
      const sameAttempt = current?.journal.attempt === checked.attempt;
      await this.#vault.keepRequired(
        this.#stateName(),
        {
          version: 1,
          householdId: this.#vault.libraryId,
          journal: checked,
          ...(sameAttempt && current?.authorization
            ? { authorization: checkedCommitAuthorization(current.authorization, checked) }
            : {}),
          ...(sameAttempt && current?.recovery ? { recovery: current.recovery } : {}),
        } satisfies DurableOwnerSplitState,
        this.#stateBinding(),
      );
    });
  }

  async authorizeCommit(
    journal: OwnerSplitJournal & { readonly state: 'ready-to-commit' },
    authorization: OwnerSplitCommitAuthorization,
  ): Promise<void> {
    const checked = checkedOwnerSplitJournal(journal);
    checkedCommitAuthorization(authorization, journal);
    if (checked?.state !== 'ready-to-commit') throw new Error('Owner split is not ready to commit');
    await this.#locked(async () => {
      const current = await this.#state();
      if (
        current?.journal.attempt !== journal.attempt ||
        canonical(current.journal) !== canonical(checked)
      )
        throw new Error('Owner split journal changed before authorization');
      // One AES-GCM envelope/one Vault put makes the ready journal and its separately typed authorization durable
      // together. The coordinator still requires both independently bound members before it may commit.
      await this.#vault.keepRequired(
        this.#stateName(),
        {
          version: 1,
          householdId: this.#vault.libraryId,
          journal: checked,
          authorization,
          ...(current.recovery ? { recovery: current.recovery } : {}),
        } satisfies DurableOwnerSplitState,
        this.#stateBinding(),
      );
    });
  }

  async loadCommitAuthorization(attempt: string): Promise<OwnerSplitCommitAuthorization | null> {
    checkedAttempt(attempt);
    const value = (await this.#state())?.authorization;
    if (value === undefined) return null;
    return checkedCommitAuthorization(value, { attempt });
  }

  async authorizeRecovery(intent: OwnerSplitRecoveryIntent): Promise<void> {
    const checked = checkedRecoveryIntent(intent);
    await this.#locked(async () => {
      const current = await this.#state();
      if (current === null || current.journal.attempt !== intent.attempt)
        throw new Error('Owner split journal changed before recovery authorization');
      await this.#vault.keepRequired(
        this.#stateName(),
        { ...current, recovery: checked } satisfies DurableOwnerSplitState,
        this.#stateBinding(),
      );
    });
  }

  async loadRecoveryIntent(attempt: string): Promise<OwnerSplitRecoveryIntent | null> {
    checkedAttempt(attempt);
    const value = (await this.#state())?.recovery;
    if (value === undefined) return null;
    const checked = checkedRecoveryIntent(value);
    if (checked.attempt !== attempt) throw new Error('Recovery intent attempt does not match');
    return checked;
  }

  async clear(attempt: string): Promise<void> {
    checkedAttempt(attempt);
    await this.#locked(async () => {
      const current = await this.#state();
      if (current !== null && current.journal.attempt !== attempt)
        throw new Error('Refusing to clear another Owner split attempt');
      await this.#vault.discardKept(this.#stateName());
    });
  }

  async #state(): Promise<DurableOwnerSplitState | null> {
    const opened = await this.#vault.keptRequired<unknown>(this.#stateName(), this.#stateBinding());
    if (opened.kind === 'absent') return null;
    const value = opened.value;
    if (!record(value) || value.version !== 1 || value.householdId !== this.#vault.libraryId)
      throw new Error('Owner split durable state is unavailable or corrupt');
    const journal = checkedOwnerSplitJournal(value.journal as OwnerSplitJournal);
    if (journal === null) throw new Error('Owner split durable state is unavailable or corrupt');
    const authorization =
      value.authorization === undefined
        ? undefined
        : checkedCommitAuthorization(value.authorization, journal);
    const recovery =
      value.recovery === undefined ? undefined : checkedRecoveryIntent(value.recovery);
    if (recovery !== undefined && recovery.attempt !== journal.attempt)
      throw new Error('Recovery intent attempt does not match');
    return {
      version: 1,
      householdId: this.#vault.libraryId,
      journal,
      ...(authorization ? { authorization } : {}),
      ...(recovery ? { recovery } : {}),
    };
  }

  #locked<T>(work: () => Promise<T>): Promise<T> {
    return exclusive(`den.profileMigration.${this.#vault.libraryId}`, work);
  }

  #stateName(): string {
    return 'profile-migration/v1/state';
  }

  #candidateName(keyRef: string): string {
    return `profile-migration/v1/candidate/${keyRef}`;
  }

  #candidateBinding(attempt: string): string {
    return `candidate:${this.#vault.libraryId}:${attempt}:${CANDIDATE_VERSION}`;
  }

  #stateBinding(): string {
    return `state:${this.#vault.libraryId}:1`;
  }
}

function checkedCandidateCredential(value: unknown): SealedCandidateCredential {
  if (!record(value)) throw new Error('Candidate credential is unavailable or corrupt');
  if (
    value.version !== CANDIDATE_VERSION ||
    value.keyVersion !== CANDIDATE_VERSION ||
    typeof value.householdId !== 'string' ||
    !ID.test(value.householdId) ||
    typeof value.attempt !== 'string' ||
    !ATTEMPT.test(value.attempt) ||
    typeof value.keyRef !== 'string' ||
    !KEY_REF.test(value.keyRef) ||
    typeof value.profileId !== 'string' ||
    !ID.test(value.profileId) ||
    typeof value.libraryId !== 'string' ||
    !ID.test(value.libraryId) ||
    typeof value.keyFingerprint !== 'string' ||
    !DIGEST.test(value.keyFingerprint) ||
    !Number.isSafeInteger(value.createdAt) ||
    Number(value.createdAt) < 0 ||
    typeof value.libraryKey !== 'string'
  )
    throw new Error('Candidate credential is unavailable or corrupt');
  return value as unknown as SealedCandidateCredential;
}

function checkedCommitAuthorization(
  value: unknown,
  journal: Pick<OwnerSplitJournal, 'attempt'> &
    Partial<Pick<OwnerSplitJournal, 'ownerHead' | 'stagedDigest'>>,
): OwnerSplitCommitAuthorization {
  if (
    !record(value) ||
    value.version !== 1 ||
    value.commitAuthorized !== true ||
    value.attempt !== journal.attempt ||
    typeof value.ownerHead !== 'string' ||
    !DIGEST.test(value.ownerHead) ||
    typeof value.stagedDigest !== 'string' ||
    !DIGEST.test(value.stagedDigest) ||
    (journal.ownerHead !== undefined && value.ownerHead !== journal.ownerHead) ||
    (journal.stagedDigest !== undefined && value.stagedDigest !== journal.stagedDigest)
  )
    throw new Error('Commit authorization is unavailable or corrupt');
  return value as unknown as OwnerSplitCommitAuthorization;
}

function checkedRecoveryIntent(value: unknown): OwnerSplitRecoveryIntent {
  if (
    !record(value) ||
    value.version !== 1 ||
    value.recoveryIntent !== true ||
    typeof value.attempt !== 'string' ||
    !ATTEMPT.test(value.attempt) ||
    typeof value.recoveryAttempt !== 'string' ||
    !ATTEMPT.test(value.recoveryAttempt)
  )
    throw new Error('Recovery intent is unavailable or corrupt');
  return value as unknown as OwnerSplitRecoveryIntent;
}

function publicHandle(record: SealedCandidateCredential): OwnerSplitCandidateHandle {
  return {
    profileId: record.profileId,
    libraryId: record.libraryId,
    keyRef: record.keyRef,
    keyFingerprint: record.keyFingerprint,
  };
}

function checkedAttempt(value: string): void {
  if (!ATTEMPT.test(value)) throw new Error('Migration attempt is not canonical');
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}

function toBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const decoded = atob(value);
    const raw = new Uint8Array(new ArrayBuffer(decoded.length));
    for (let index = 0; index < decoded.length; index += 1) raw[index] = decoded.charCodeAt(index);
    return btoa(String.fromCharCode(...raw)) === value ? raw : null;
  } catch {
    return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
