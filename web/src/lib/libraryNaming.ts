import { untrack } from 'svelte';
import { titleKey, type MediaType, type Shape, type Title } from './library';
import type { LibraryMetadataShape, LibraryMetadataTitle } from './libraryServiceProtocol';

type Ref = { type: MediaType; id: number };

interface NamedLibrary {
  displays: Title[];
  shapes: Map<string, Shape>;
  libraryMetadata(refs: readonly Ref[]): Promise<{
    titles: LibraryMetadataTitle[];
    shapes: LibraryMetadataShape[];
    retryable: Ref[];
    retryAfterMs?: number;
  }>;
  publishLibraryMetadata?: (
    titles: Title[],
    shapes: ReadonlyArray<readonly [string, Shape]>,
    missing?: readonly Ref[],
  ) => void;
}

const shapeFromWire = (shape: LibraryMetadataShape): Shape => ({
  counts: new Map(shape.seasons.map(({ season, episodes }) => [season, episodes])),
  ...(shape.lastAired ? { lastAired: shape.lastAired } : {}),
});

/** Small enough to paint progressively and to leave room in the relay's per-minute member allowance. */
export const LIBRARY_METADATA_BATCH = 64;
const RETRIES = 2;
const RETRY_DELAY_MS = 1_000;

interface RetryState {
  pending: Map<string, Ref>;
  attempts: Map<string, number>;
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
  retryAfterMs: number;
}

const retryStates = new WeakMap<NamedLibrary, RetryState>();
const closedSessions = new WeakSet<NamedLibrary>();

/**
 * Ask the library service to name an explicit set. A large lazy screen paints one bounded batch at a time;
 * transient Worker/provider failures are retried without discarding successful neighbours.
 */
export async function nameLibraryTitles(session: NamedLibrary, refs: Ref[]): Promise<void> {
  if (closedSessions.has(session)) return;
  // This function is commonly started inside a route effect. Its page cache is an implementation detail, not an
  // input to that effect: progressive publication must not restart the owning naming pass after every 64-title batch.
  const { known, wanted } = untrack(() => {
    const known = new Set(session.displays.map(titleKey));
    const wanted = [
      ...new Map(refs.map((ref) => [titleKey(ref), { type: ref.type, id: ref.id }])).values(),
    ].filter(
      (ref) =>
        !known.has(titleKey(ref)) || (ref.type === 'tv' && !session.shapes.has(titleKey(ref))),
    );
    return { known, wanted };
  });
  const retry = await nameBatches(session, wanted, known);
  // Readiness is the first bounded pass, not the provider's backoff. Successful neighbours are already visible;
  // retry transient holes in the background without holding Home's shelves behind them.
  queueLibraryTitleRetries(session, retry.refs, retry.retryAfterMs);
}

async function nameBatches(
  session: NamedLibrary,
  refs: Ref[],
  known: Set<string>,
): Promise<{ refs: Ref[]; retryAfterMs: number }> {
  const retry: Ref[] = [];
  let retryAfterMs = 0;
  for (let at = 0; at < refs.length; at += LIBRARY_METADATA_BATCH) {
    if (closedSessions.has(session)) return { refs: [], retryAfterMs: 0 };
    const batch = refs.slice(at, at + LIBRARY_METADATA_BATCH);
    const found = await session.libraryMetadata(batch).catch(() => null);
    if (closedSessions.has(session)) return { refs: [], retryAfterMs: 0 };
    if (!found) {
      retry.push(...batch);
      continue;
    }
    retryAfterMs = Math.max(retryAfterMs, found.retryAfterMs ?? 0);
    const titles = found.titles.filter((title) => !known.has(titleKey(title)));
    for (const title of found.titles) known.add(titleKey(title));
    const answered = new Set([...found.titles.map(titleKey), ...found.retryable.map(titleKey)]);
    const absent = batch.filter((ref) => !answered.has(titleKey(ref)));
    const shapes = found.shapes.map(
      (shape) => [titleKey(shape.title), shapeFromWire(shape)] as const,
    );
    if (titles.length || shapes.length) {
      if (session.publishLibraryMetadata) session.publishLibraryMetadata(titles, shapes, absent);
      else {
        if (titles.length) session.displays = [...session.displays, ...titles];
        if (shapes.length) session.shapes = new Map([...session.shapes, ...shapes]);
      }
    } else if (absent.length && session.publishLibraryMetadata)
      session.publishLibraryMetadata([], [], absent);
    retry.push(...found.retryable);
  }
  return { refs: missing(session, retry, known), retryAfterMs };
}

function queueLibraryTitleRetries(session: NamedLibrary, refs: Ref[], retryAfterMs = 0): void {
  if (!refs.length || closedSessions.has(session)) return;
  let state = retryStates.get(session);
  if (!state) {
    state = { pending: new Map(), attempts: new Map(), running: false, retryAfterMs: 0 };
    retryStates.set(session, state);
  }
  for (const ref of refs) state.pending.set(titleKey(ref), ref);
  state.retryAfterMs = Math.max(state.retryAfterMs, retryAfterMs);
  scheduleLibraryTitleRetries(session, state);
}

function scheduleLibraryTitleRetries(session: NamedLibrary, state: RetryState): void {
  if (state.timer || state.running || !state.pending.size || closedSessions.has(session)) return;
  const delay = Math.max(RETRY_DELAY_MS, state.retryAfterMs);
  state.retryAfterMs = 0;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    void runLibraryTitleRetries(session, state);
  }, delay);
}

async function runLibraryTitleRetries(session: NamedLibrary, state: RetryState): Promise<void> {
  if (closedSessions.has(session)) return;
  state.running = true;
  const offered = [...state.pending.values()];
  state.pending.clear();
  const known = new Set(session.displays.map(titleKey));
  const due = missing(session, offered, known);
  const dueKeys = new Set(due.map(titleKey));
  for (const ref of offered) if (!dueKeys.has(titleKey(ref))) state.attempts.delete(titleKey(ref));
  for (const ref of due) {
    const key = titleKey(ref);
    state.attempts.set(key, (state.attempts.get(key) ?? 0) + 1);
  }
  const retry = await nameBatches(session, due, known);
  if (closedSessions.has(session)) return;
  const retryKeys = new Set(retry.refs.map(titleKey));
  const exhausted: Ref[] = [];
  for (const ref of due) {
    const key = titleKey(ref);
    if (!retryKeys.has(key)) {
      state.pending.delete(key);
      state.attempts.delete(key);
    } else if ((state.attempts.get(key) ?? 0) >= RETRIES) {
      state.pending.delete(key);
      state.attempts.delete(key);
      exhausted.push(ref);
    } else state.pending.set(key, ref);
  }
  if (exhausted.length)
    console.warn(
      `den: ${exhausted.length} library title${exhausted.length === 1 ? '' : 's'} could not be named`,
    );
  state.running = false;
  state.retryAfterMs = Math.max(state.retryAfterMs, retry.retryAfterMs);
  scheduleLibraryTitleRetries(session, state);
}

/** End the session's one retry timer and prevent an in-flight answer from publishing after close. */
export function cancelLibraryTitleNaming(session: NamedLibrary): void {
  closedSessions.add(session);
  const state = retryStates.get(session);
  if (!state) return;
  clearTimeout(state.timer);
  state.pending.clear();
  state.attempts.clear();
  retryStates.delete(session);
}

const missing = (session: NamedLibrary, refs: Ref[], known: Set<string>): Ref[] => [
  ...new Map(
    refs
      .filter(
        (ref) =>
          !known.has(titleKey(ref)) || (ref.type === 'tv' && !session.shapes.has(titleKey(ref))),
      )
      .map((ref) => [titleKey(ref), ref]),
  ).values(),
];

/** A direct route or pointer intent asks the same Worker-owned metadata path at foreground priority. */
export function promoteLibraryTitle(session: NamedLibrary, ref: Ref): Promise<void> {
  return nameLibraryTitles(session, [ref]);
}
