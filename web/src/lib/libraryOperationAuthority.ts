import type { LibraryCommand, LibraryTask } from './libraryServiceProtocol';
import {
  LibraryServiceAuthorityError,
  type LibraryAuthorityCommandResult,
  type LibraryAuthorityTaskResult,
  type LibraryServiceAuthority,
} from './libraryServiceCore';
import type { LibraryLog } from './log';

const JOURNAL = 'library-service-operations.v1';
const LIMIT = 1_024;

type Entry =
  | {
      kind: 'command';
      operationId: string;
      request: string;
      result: LibraryAuthorityCommandResult;
    }
  | {
      kind: 'task';
      operationId: string;
      request: string;
      result: LibraryAuthorityTaskResult;
    };

/**
 * Durable replay protection around the semantic authority. The journal is sealed by LibraryLog.keep under the
 * library-derived local key, so neither operation payloads nor administrative results are stored in plaintext.
 */
export class DurableOperationAuthority implements LibraryServiceAuthority {
  #loaded?: Promise<Entry[]>;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly authority: LibraryServiceAuthority,
    private readonly log: LibraryLog,
  ) {}

  get generation() {
    return this.authority.generation;
  }

  select: LibraryServiceAuthority['select'] = (selection) => this.authority.select(selection);
  query: LibraryServiceAuthority['query'] = (query) => this.authority.query(query);
  observe: LibraryServiceAuthority['observe'] = (observation) =>
    this.authority.observe(observation);
  listen: NonNullable<LibraryServiceAuthority['listen']> = (listener) =>
    this.authority.listen?.(listener) ?? (() => {});

  command(command: LibraryCommand, operationId: string): Promise<LibraryAuthorityCommandResult> {
    return this.#serialized(() =>
      this.#perform('command', operationId, command, () =>
        this.authority.command(command, operationId),
      ),
    );
  }

  task(task: LibraryTask, operationId: string): Promise<LibraryAuthorityTaskResult> {
    return this.#serialized(() =>
      this.#perform('task', operationId, task, () => this.authority.task(task, operationId)),
    );
  }

  async close(): Promise<void> {
    await this.#tail;
    await this.authority.close?.();
  }

  #serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #perform<K extends Entry['kind']>(
    kind: K,
    operationId: string,
    request: LibraryCommand | LibraryTask,
    work: () => Promise<
      K extends 'command' ? LibraryAuthorityCommandResult : LibraryAuthorityTaskResult
    >,
  ): Promise<K extends 'command' ? LibraryAuthorityCommandResult : LibraryAuthorityTaskResult> {
    const requestText = JSON.stringify(request);
    const entries = await this.#entries();
    const found = entries.find((entry) => entry.operationId === operationId);
    if (found) {
      if (found.kind !== kind || found.request !== requestText)
        throw new LibraryServiceAuthorityError({
          code: 'conflict',
          message: 'operationId was already used for another operation',
          retryable: false,
        });
      return structuredClone(found.result) as K extends 'command'
        ? LibraryAuthorityCommandResult
        : LibraryAuthorityTaskResult;
    }

    const result = await work();
    const taskResult = result as LibraryAuthorityTaskResult;
    if (
      kind === 'task' &&
      taskResult.result.kind === 'history.import' &&
      !taskResult.result.complete
    )
      return result;
    entries.push({ kind, operationId, request: requestText, result } as Entry);
    if (entries.length > LIMIT) entries.splice(0, entries.length - LIMIT);
    await this.log.keep(JOURNAL, entries);
    return result;
  }

  async #entries(): Promise<Entry[]> {
    if (!this.#loaded)
      this.#loaded = this.log
        .kept<unknown>(JOURNAL)
        .then((stored) =>
          Array.isArray(stored)
            ? stored.filter(
                (entry): entry is Entry =>
                  !!entry &&
                  typeof entry === 'object' &&
                  !Array.isArray(entry) &&
                  ((entry as { kind?: unknown }).kind === 'command' ||
                    (entry as { kind?: unknown }).kind === 'task') &&
                  typeof (entry as { operationId?: unknown }).operationId === 'string' &&
                  typeof (entry as { request?: unknown }).request === 'string' &&
                  !!(entry as { result?: unknown }).result,
              )
            : [],
        );
    return this.#loaded;
  }
}
