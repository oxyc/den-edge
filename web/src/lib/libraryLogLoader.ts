import type { LibraryLog } from './log';

type LibraryLogClass = typeof LibraryLog;

let loading: Promise<LibraryLogClass> | undefined;

/** The mutable log is materialized only when compact Worker-owned Home state no longer suffices. */
export const loadLibraryLog = (): Promise<LibraryLogClass> =>
  (loading ??= import('./log').then(({ LibraryLog }) => LibraryLog));
