import type { LibraryCommand, LibraryTask } from './libraryServiceProtocol';
import {
  LibraryServiceAuthorityError,
  type LibraryAuthorityCommandResult,
  type LibraryAuthorityTaskResult,
  type LibraryServiceAuthority,
} from './libraryServiceCore';
import type { LibraryLog } from './log';
import { exclusive } from './exclusive';

export const LIBRARY_OPERATION_JOURNAL = 'library-service-operations.v2';
const LEGACY_JOURNAL = 'library-service-operations.v1';
const ENTRY_LIMIT = 1_024;
const BYTE_LIMIT = 256 * 1_024;
const RESULT_BYTE_LIMIT = 32 * 1_024;
const utf8 = new TextEncoder();

type OperationKind = 'command' | 'task';
type OperationResult = LibraryAuthorityCommandResult | LibraryAuthorityTaskResult;

type Entry = {
  kind: OperationKind;
  operationId: string;
  requestDigest: string;
  state: 'intent' | 'complete';
  result?: OperationResult;
};

const conflict = () =>
  new LibraryServiceAuthorityError({
    code: 'conflict',
    message: 'operationId was already used for another operation',
    retryable: false,
  });

const storageFailure = (message: string) =>
  new LibraryServiceAuthorityError({ code: 'storage', message, retryable: true });

async function digest(request: LibraryCommand | LibraryTask): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', utf8.encode(JSON.stringify(request)));
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function decodedEntries(value: unknown): Entry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): Entry[] => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const entry = candidate as Partial<Entry>;
    if (
      (entry.kind !== 'command' && entry.kind !== 'task') ||
      typeof entry.operationId !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry.requestDigest ?? '') ||
      (entry.state !== 'intent' && entry.state !== 'complete') ||
      (entry.state === 'complete' && !entry.result)
    )
      return [];
    return [
      {
        kind: entry.kind,
        operationId: entry.operationId,
        requestDigest: entry.requestDigest!,
        state: entry.state,
        ...(entry.state === 'complete' ? { result: structuredClone(entry.result!) } : {}),
      },
    ];
  });
}

async function entries(log: LibraryLog): Promise<Entry[]> {
  const current = await log.kept<unknown>(LIBRARY_OPERATION_JOURNAL);
  if (current !== undefined) return decodedEntries(current);
  const legacy = await log.kept<unknown>(LEGACY_JOURNAL);
  if (!Array.isArray(legacy)) return [];
  const migrated: Entry[] = [];
  for (const candidate of legacy) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const entry = candidate as {
      kind?: unknown;
      operationId?: unknown;
      request?: unknown;
      result?: unknown;
    };
    if (
      (entry.kind !== 'command' && entry.kind !== 'task') ||
      typeof entry.operationId !== 'string' ||
      typeof entry.request !== 'string' ||
      !entry.result
    )
      continue;
    try {
      migrated.push({
        kind: entry.kind,
        operationId: entry.operationId,
        requestDigest: await digest(JSON.parse(entry.request) as LibraryCommand | LibraryTask),
        state: 'complete',
        result: structuredClone(entry.result as OperationResult),
      });
    } catch {
      // An unreadable legacy receipt is ignored; authenticated storage still prevents attacker-supplied entries.
    }
  }
  return migrated;
}

function bounded(current: Entry[], protectedOperationId: string): Entry[] {
  const kept = current.slice(-ENTRY_LIMIT);
  while (utf8.encode(JSON.stringify(kept)).byteLength > BYTE_LIMIT && kept.length > 1) {
    const removable = kept.findIndex((entry) => entry.operationId !== protectedOperationId);
    if (removable < 0) break;
    kept.splice(removable, 1);
  }
  if (utf8.encode(JSON.stringify(kept)).byteLength > BYTE_LIMIT)
    throw storageFailure('operation result exceeds the durable journal limit');
  return kept;
}

async function keep(
  log: LibraryLog,
  current: Entry[],
  protectedOperationId: string,
): Promise<void> {
  await log.keep(LIBRARY_OPERATION_JOURNAL, bounded(current, protectedOperationId));
}

/** Copy a completed reset task into the destination library before the source authority returns. */
export async function completeDurableTaskOperation(
  log: LibraryLog,
  operationId: string,
  task: LibraryTask,
  result: LibraryAuthorityTaskResult,
  runExclusive: typeof exclusive = exclusive,
): Promise<void> {
  const requestDigest = await digest(task);
  if (utf8.encode(JSON.stringify(result)).byteLength > RESULT_BYTE_LIMIT)
    throw storageFailure('operation result exceeds the durable result limit');
  await runExclusive(`den.library.operations.${log.libraryId}`, async () => {
    const current = await entries(log);
    const found = current.find((entry) => entry.operationId === operationId);
    if (found && (found.kind !== 'task' || found.requestDigest !== requestDigest)) throw conflict();
    const complete: Entry = {
      kind: 'task',
      operationId,
      requestDigest,
      state: 'complete',
      result: structuredClone(result),
    };
    if (found) current[current.indexOf(found)] = complete;
    else current.push(complete);
    await keep(log, current, operationId);
  });
}

/**
 * Durable replay protection around the semantic authority. A bounded encrypted intent lands before any effect. A
 * retry may safely resume an incomplete intent because domain writes have set/idempotent semantics; completion then
 * stores the original semantic result for exact lost-reply replay.
 */
export class DurableOperationAuthority implements LibraryServiceAuthority {
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly authority: LibraryServiceAuthority,
    private readonly log: LibraryLog,
    private readonly runExclusive: typeof exclusive = exclusive,
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
      this.runExclusive(`den.library.operations.${this.log.libraryId}`, () =>
        this.#perform('command', operationId, command, () =>
          this.authority.command(command, operationId),
        ),
      ),
    );
  }

  task(task: LibraryTask, operationId: string): Promise<LibraryAuthorityTaskResult> {
    return this.#serialized(() =>
      this.runExclusive(`den.library.operations.${this.log.libraryId}`, () =>
        this.#perform('task', operationId, task, () => this.authority.task(task, operationId)),
      ),
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

  async #perform<K extends OperationKind>(
    kind: K,
    operationId: string,
    request: LibraryCommand | LibraryTask,
    work: () => Promise<
      K extends 'command' ? LibraryAuthorityCommandResult : LibraryAuthorityTaskResult
    >,
  ): Promise<K extends 'command' ? LibraryAuthorityCommandResult : LibraryAuthorityTaskResult> {
    const requestDigest = await digest(request);
    const current = await entries(this.log);
    const found = current.find((entry) => entry.operationId === operationId);
    if (found) {
      if (found.kind !== kind || found.requestDigest !== requestDigest) throw conflict();
      if (found.state === 'complete')
        return structuredClone(found.result) as K extends 'command'
          ? LibraryAuthorityCommandResult
          : LibraryAuthorityTaskResult;
    } else {
      current.push({ kind, operationId, requestDigest, state: 'intent' });
      await keep(this.log, current, operationId);
    }

    const result = await work();
    const taskResult = result as LibraryAuthorityTaskResult;
    if (
      kind === 'task' &&
      taskResult.result.kind === 'history.import' &&
      !taskResult.result.complete
    )
      return result;
    if (utf8.encode(JSON.stringify(result)).byteLength > RESULT_BYTE_LIMIT)
      throw storageFailure('operation result exceeds the durable result limit');

    const latest = await entries(this.log);
    const intent = latest.find((entry) => entry.operationId === operationId);
    if (intent && (intent.kind !== kind || intent.requestDigest !== requestDigest))
      throw conflict();
    const complete: Entry = {
      kind,
      operationId,
      requestDigest,
      state: 'complete',
      result: structuredClone(result),
    };
    if (intent) latest[latest.indexOf(intent)] = complete;
    else latest.push(complete);
    await keep(this.log, latest, operationId);
    return result;
  }
}
