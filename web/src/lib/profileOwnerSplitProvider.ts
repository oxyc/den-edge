import type {
  OwnerSplitAttemptLookup,
  OwnerSplitBackup,
  OwnerSplitCandidateHandle,
  OwnerSplitFence,
  OwnerSplitHouseholdObservation,
  OwnerSplitProvider,
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
      answer.wireMin !== 4 ||
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
        profilesRow: input.authority.profilesRow ?? null,
        protectedLibraryIds: input.protectedLibraryIds,
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
    readonly fence: OwnerSplitFence;
    readonly observation: OwnerSplitHouseholdObservation;
    readonly plannerDecision: string;
  }): Promise<OwnerSplitAttemptLookup> {
    const answer = await this.#transport.request({
      method: 'POST',
      path: `${this.#attemptPath(input.attempt)}/restore`,
      body: {
        backup: input.backup,
        fence: input.fence,
        wireMin: 4,
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
    return checkedLookup(answer, input.attempt);
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
  if (
    !record(value) ||
    value.attempt !== attempt ||
    !['open', 'aborted', 'committed', 'restored', 'superseded'].includes(String(value.state)) ||
    !record(value.fence) ||
    !Number.isSafeInteger(value.fence.generation) ||
    !Number.isSafeInteger(value.fence.base) ||
    !DIGEST.test(String(value.fence.head)) ||
    typeof value.fence.rewrite !== 'string'
  )
    throw new Error('Provider returned invalid migration attempt evidence');
  return value as unknown as OwnerSplitAttemptLookup;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
