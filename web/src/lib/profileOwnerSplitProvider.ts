import type {
  OwnerSplitAttemptLookup,
  OwnerSplitBackup,
  OwnerSplitCandidateHandle,
  OwnerSplitFence,
  OwnerSplitHouseholdObservation,
  OwnerSplitOpenAttempt,
  OwnerSplitProvider,
  OwnerSplitWinner,
} from './profileOwnerSplitEngine';

const ID = /^[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;

/** Worker-owned authenticated request boundary. Implementations add credentials as headers, never URLs. */
export interface OwnerSplitMigrationTransport {
  request(input: {
    readonly method: 'GET' | 'POST' | 'DELETE';
    readonly path: string;
    readonly body?: unknown;
    /** Resolve this opaque reference to the candidate token inside the worker. */
    readonly candidateKeyRef?: string;
  }): Promise<unknown>;
  readHousehold(): Promise<OwnerSplitHouseholdObservation>;
}

/** Exact den-edge #443 route adapter. It owns no credentials and accepts none in a URL. */
export class HttpOwnerSplitProvider implements OwnerSplitProvider {
  readonly #householdId: string;
  readonly #transport: OwnerSplitMigrationTransport;

  constructor(householdId: string, transport: OwnerSplitMigrationTransport) {
    if (!ID.test(householdId)) throw new TypeError('Household id is not canonical');
    this.#householdId = householdId;
    this.#transport = transport;
  }

  open(attempt: string, purpose: 'split' | 'restore'): Promise<OwnerSplitAttemptLookup> {
    return this.#attemptRequest('POST', attempt, undefined, { attempt, purpose });
  }

  lookup(attempt: string): Promise<OwnerSplitAttemptLookup> {
    return this.#attemptRequest('GET', attempt);
  }

  abort(attempt: string): Promise<OwnerSplitAttemptLookup> {
    return this.#attemptRequest('DELETE', attempt);
  }

  async createBackup(attempt: string): Promise<{ readonly id: string; readonly digest: string }> {
    const answer = await this.#transport.request({
      method: 'POST',
      path: `${this.#attemptPath(attempt)}/backup`,
    });
    if (
      !record(answer) ||
      typeof answer.id !== 'string' ||
      !answer.id ||
      !DIGEST.test(String(answer.digest))
    )
      throw new Error('Provider returned an invalid backup reference');
    return { id: answer.id, digest: String(answer.digest) };
  }

  async readBackup(attempt: string): Promise<OwnerSplitBackup> {
    const answer = await this.#transport.request({
      method: 'GET',
      path: `${this.#attemptPath(attempt)}/backup`,
    });
    if (
      !record(answer) ||
      answer.attempt !== attempt ||
      answer.householdId !== this.#householdId ||
      checkedWireMin(answer.wireMin) === null ||
      typeof answer.id !== 'string' ||
      !DIGEST.test(String(answer.digest)) ||
      !Array.isArray(answer.rows)
    )
      throw new Error('Provider returned an invalid backup manifest');
    return answer as unknown as OwnerSplitBackup;
  }

  readHousehold(): Promise<OwnerSplitHouseholdObservation> {
    return this.#transport.readHousehold();
  }

  async retireCandidate(input: {
    readonly attempt: string;
    readonly source: OwnerSplitFence;
    readonly authority: OwnerSplitHouseholdObservation;
    readonly candidate: OwnerSplitCandidateHandle;
    readonly protectedLibraryIds: readonly string[];
  }): Promise<'retired' | 'absent'> {
    const protectedLibraryIds = checkedProtectedIds(
      this.#householdId,
      input.candidate.libraryId,
      input.protectedLibraryIds,
    );
    const answer = await this.#transport.request({
      method: 'POST',
      path: `${this.#attemptPath(input.attempt)}/retire-candidate`,
      candidateKeyRef: input.candidate.keyRef,
      body: {
        source: input.source,
        authority: {
          generation: input.authority.generation,
          base: input.authority.base,
          head: input.authority.head,
          kind: input.authority.kind === 'legacy' ? 'changed-legacy' : input.authority.kind,
        },
        profilesRow: input.authority.profilesRow
          ? {
              k: input.authority.profilesRow.k,
              seq: input.authority.profilesRow.seq,
              v: input.authority.profilesRow.v,
            }
          : null,
        protectedLibraryIds,
        candidateLibraryId: input.candidate.libraryId,
      },
    });
    if (!record(answer) || (answer.result !== 'retired' && answer.result !== 'absent'))
      throw new Error('Provider returned invalid candidate retirement evidence');
    return answer.result;
  }

  async restore(input: {
    readonly attempt: string;
    readonly backup: { readonly attempt: string; readonly id: string; readonly digest: string };
    readonly observation: OwnerSplitHouseholdObservation;
    readonly plannerDecision: string;
  }): Promise<OwnerSplitAttemptLookup> {
    const recovery = checkedRestoreRecovery(await this.lookup(input.attempt));
    const answer = await this.#transport.request({
      method: 'POST',
      path: `${this.#attemptPath(recovery.attempt)}/restore`,
      body: {
        backup: input.backup,
        fence: recovery.fence,
        wireMin: recovery.wireMin,
        profilesRow: input.observation.profilesRow
          ? {
              present: true,
              seq: input.observation.profilesRow.seq,
              digest: input.observation.profilesRow.digest,
            }
          : { present: false, seq: null, digest: null },
        directoryState: input.observation.kind === 'corrupt' ? 'invalid' : 'absent',
        plannerDecision: input.plannerDecision,
      },
    });
    return checkedLookup(answer, recovery.attempt);
  }

  async #attemptRequest(
    method: 'GET' | 'POST' | 'DELETE',
    attempt: string,
    operation?: string,
    body?: unknown,
  ): Promise<OwnerSplitAttemptLookup> {
    const path = operation
      ? `${this.#attemptPath(attempt)}/${operation}`
      : this.#attemptPath(attempt, method === 'POST');
    return checkedLookup(await this.#transport.request({ method, path, body }), attempt);
  }

  #attemptPath(attempt: string, collection = false): string {
    if (!ID.test(attempt)) throw new TypeError('Migration attempt is not canonical');
    const root = `/lib/${this.#householdId}/profile-migration`;
    return collection ? root : `${root}/${attempt}`;
  }
}

function checkedLookup(value: unknown, attempt: string): OwnerSplitAttemptLookup {
  if (!record(value) || value.attempt !== attempt || !ID.test(attempt)) return invalidLookup();
  const purpose = value.purpose;
  if (purpose !== 'split' && purpose !== 'restore') return invalidLookup();
  const wireMin = checkedWireMin(value.wireMin);
  const fence = parsedFence(value.fence);
  if (wireMin === null || fence === null) return invalidLookup();
  const common = { attempt, purpose, wireMin, fence } as const;

  if (value.state === 'open' || value.state === 'aborted') return { ...common, state: value.state };
  if (value.state === 'committed') {
    if (purpose !== 'split') return invalidLookup();
    const terminal = parsedTerminal(value, attempt, 'committed');
    return terminal === null
      ? invalidLookup()
      : { ...common, ...terminal, purpose: 'split', state: 'committed' };
  }
  if (value.state === 'restored') {
    if (purpose !== 'restore') return invalidLookup();
    const terminal = parsedTerminal(value, attempt, 'restored');
    return terminal === null
      ? invalidLookup()
      : { ...common, ...terminal, purpose: 'restore', state: 'restored' };
  }
  if (value.state === 'superseded') {
    const winner = parsedWinner(value.winner);
    return winner === null ? invalidLookup() : { ...common, state: 'superseded', winner };
  }
  return invalidLookup();
}

type ParsedTerminalBase = {
  readonly attempt: string;
  readonly generation: number;
  readonly base: number;
  readonly head: string;
  readonly wireMin: number;
  readonly backup: { readonly id: string; readonly digest: string };
};

function parsedTerminal(
  value: Record<string, unknown>,
  attempt: string,
  state: 'committed',
): (ParsedTerminalBase & { readonly stagedDigest: string }) | null;
function parsedTerminal(
  value: Record<string, unknown>,
  attempt: string,
  state: 'restored',
): (ParsedTerminalBase & { readonly stagedDigest: null }) | null;
function parsedTerminal(
  value: Record<string, unknown>,
  attempt: string,
  state: 'committed' | 'restored',
): (ParsedTerminalBase & { readonly stagedDigest: string | null }) | null {
  if (value.attempt !== attempt) return null;
  const generation = checkedCount(value.generation);
  const base = checkedCount(value.base);
  const wireMin = checkedWireMin(value.wireMin);
  const head = checkedDigest(value.head);
  const backup = parsedBackup(value.backup);
  const stagedDigest = parsedStagedDigest(state, value.stagedDigest);
  if (
    generation === null ||
    base === null ||
    wireMin === null ||
    head === null ||
    backup === null ||
    stagedDigest === undefined
  )
    return null;
  return { attempt, generation, base, head, wireMin, backup, stagedDigest };
}

function parsedWinner(value: unknown): OwnerSplitWinner | null {
  if (!record(value) || !ID.test(String(value.attempt))) return null;
  if (value.state === 'committed') {
    const terminal = parsedTerminal(value, String(value.attempt), 'committed');
    return terminal === null ? null : { ...terminal, state: 'committed' };
  }
  if (value.state === 'restored') {
    const terminal = parsedTerminal(value, String(value.attempt), 'restored');
    return terminal === null ? null : { ...terminal, state: 'restored' };
  }
  return null;
}

function parsedStagedDigest(
  state: 'committed' | 'restored',
  value: unknown,
): string | null | undefined {
  if (state === 'restored') return value === null ? null : undefined;
  return typeof value === 'string' && DIGEST.test(value) ? value : undefined;
}

function parsedFence(value: unknown): OwnerSplitFence | null {
  if (!record(value)) return null;
  const generation = checkedCount(value.generation);
  const base = checkedCount(value.base);
  const head = checkedDigest(value.head);
  if (
    generation === null ||
    base === null ||
    head === null ||
    typeof value.rewrite !== 'string' ||
    value.rewrite.length === 0
  )
    return null;
  return { generation, base, head, rewrite: value.rewrite };
}

function parsedBackup(value: unknown): { readonly id: string; readonly digest: string } | null {
  if (!record(value) || typeof value.id !== 'string' || value.id.length === 0) return null;
  const digest = checkedDigest(value.digest);
  return digest === null ? null : { id: value.id, digest };
}

function checkedProtectedIds(
  householdId: string,
  candidateId: string,
  ids: readonly string[],
): readonly string[] {
  const protectedIds = [...new Set([householdId, ...ids])];
  if (protectedIds.some((id) => !ID.test(id)) || protectedIds.includes(candidateId))
    throw new Error('Invalid protected library set');
  return protectedIds;
}

function checkedRestoreRecovery(
  value: OwnerSplitAttemptLookup,
): OwnerSplitOpenAttempt & { readonly purpose: 'restore' } {
  if (
    value.state !== 'open' ||
    value.purpose !== 'restore' ||
    !ID.test(value.attempt) ||
    checkedWireMin(value.wireMin) === null ||
    parsedFence(value.fence) === null
  )
    throw new Error('Restore requires validated open recovery evidence');
  return { ...value, purpose: 'restore' };
}

function invalidLookup(): never {
  throw new Error('Provider returned invalid migration attempt evidence');
}

function checkedCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function checkedWireMin(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function checkedDigest(value: unknown): string | null {
  return typeof value === 'string' && DIGEST.test(value) ? value : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
