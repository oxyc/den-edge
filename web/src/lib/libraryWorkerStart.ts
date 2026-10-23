// The library Workers a page opens with, started from the entry module (`main.ts`) instead of after the whole
// application has loaded and mounted: a Worker takes as long to boot as the app module takes to evaluate, and the two
// ran one after the other. Kept tiny, since the entry imports it.

import { startupMarkOnce, startupWorkerName } from './startupTiming';

let early: Worker[] = [];

/** A new library Worker, its den-core still to be offered (`offerSyncPolicy`). */
export function newLibraryWorker(): Worker {
  // Created here, which may be well before a session takes it (`worker created`).
  startupMarkOnce('library worker started');
  return new Worker(new URL('./libraryServiceWorker.ts', import.meta.url), {
    type: 'module',
    name: startupWorkerName(),
  });
}

/**
 * How many library Workers this page opens with, read from what it keeps: one for a browser holding a library (a
 * linked TV's, or its own while browsing), and a second for a remembered Owner whose library opens beside the
 * household's (`RoutedLibrary`'s optimistic Owner). None for a browser that shows only the pairing screen.
 */
export function openingWorkers(storage: Storage = localStorage): number {
  try {
    const links = JSON.parse(storage.getItem('den.links') ?? '[]') as unknown;
    const holds =
      (Array.isArray(links) && links.length > 0) || storage.getItem('den.browsing') === '1';
    if (!holds) return 0;
    return storage.getItem('den.profile.hint.v1')?.includes('"libraryKey"') ? 2 : 1;
  } catch {
    return 0;
  }
}

export function startLibraryWorkers(count: number): void {
  for (let started = early.length; started < count; started++) early.push(newLibraryWorker());
}

/** One started early if there is one left, otherwise a new one. */
export function takeLibraryWorker(): Worker {
  return early.shift() ?? newLibraryWorker();
}

/** The page has opened what it opens with: a Worker started for a session it did not open is ended. */
export function releaseEarlyLibraryWorkers(): void {
  for (const worker of early) worker.terminate();
  early = [];
}
