import { SvelteSet } from 'svelte/reactivity';
import type { HistoryImportItem } from '../lib/libraryServiceProtocol';
import type { PlannedHistoryImport } from './historyImport';

export const importRetryNotice =
  'Couldn’t confirm the import. Changes may already be saved; trying again is safe.';

export async function saveHistoryImport(
  importHistory: (
    items: readonly HistoryImportItem[],
    operationId: string,
  ) => Promise<{ written: number; total: number; complete: boolean }>,
  writes: PlannedHistoryImport[],
  operationId: string,
  partial: (written: number, total: number) => string,
) {
  try {
    const result = await importHistory(
      writes.map((entry) => entry.item),
      operationId,
    );
    return result.complete
      ? ({ step: 'done', written: result.written } as const)
      : ({
          step: 'failed',
          message: partial(result.written, result.total),
          retry: { writes, operationId },
        } as const);
  } catch (error) {
    console.warn('den: history import could not confirm its save', error);
    return {
      step: 'failed',
      message: importRetryNotice,
      retry: { writes, operationId },
    } as const;
  }
}

/** Retain an import journey only for the activity-library object that started it. */
export function scopedImportSessions<T>(initial: T) {
  class Session {
    state = $state.raw(initial);
    excluded = new SvelteSet<string>();
  }
  const sessions = new WeakMap<object, Session>();
  return (scope: object) => {
    let session = sessions.get(scope);
    if (!session) sessions.set(scope, (session = new Session()));
    return session;
  };
}
