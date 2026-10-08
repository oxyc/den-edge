import { titleKey, type MediaType, type Shape, type Title } from './library';
import { fetchDetails, type Details } from './tmdb';

interface NamedLibrary {
  displays: Title[];
  shapes: Map<string, Shape>;
  /** Sessions publish one keyed metadata batch without making every consumer diff snapshots. */
  publishLibraryMetadata?: (
    titles: Title[],
    shapes: ReadonlyArray<readonly [string, Shape]>,
  ) => void;
}

type Ref = { type: MediaType; id: number };

interface NamingRun {
  key: string;
  pending: Map<string, Promise<void>>;
  displays: Title[];
  known: Set<string>;
  /** Found but not yet published: batching avoids one Home derivation per TMDB answer. */
  found: Map<string, Details>;
  timer?: ReturnType<typeof setTimeout>;
}

const runs = new WeakMap<NamedLibrary, NamingRun>();
const BATCH_MS = 100;

function knownTitles(session: NamedLibrary, run: NamingRun): Set<string> {
  if (run.displays !== session.displays) {
    run.displays = session.displays;
    run.known = new Set(session.displays.map(titleKey));
  }
  return run.known;
}

function publish(session: NamedLibrary, run: NamingRun): void {
  clearTimeout(run.timer);
  run.timer = undefined;
  const found = [...run.found];
  run.found.clear();
  if (runs.get(session) !== run || !found.length) return;
  const known = knownTitles(session, run);
  const titles = found.filter(([id]) => !known.has(id)).map(([, details]) => details.title);
  const shapes = found.flatMap(([id, { shape }]) => (shape ? [[id, shape] as const] : []));
  if (session.publishLibraryMetadata) session.publishLibraryMetadata(titles, shapes);
  else {
    if (titles.length) session.displays = [...session.displays, ...titles];
    if (shapes.length) session.shapes = new Map([...session.shapes, ...shapes]);
  }
  if (!titles.length) return;
  run.displays = session.displays;
  for (const title of titles) known.add(titleKey(title));
}

function namingRun(session: NamedLibrary, key: string): NamingRun {
  let run = runs.get(session);
  if (!run || run.key !== key) {
    if (run?.timer) clearTimeout(run.timer);
    const displays = session.displays;
    run = {
      key,
      pending: new Map(),
      displays,
      known: new Set(displays.map(titleKey)),
      found: new Map(),
    };
    runs.set(session, run);
  }
  return run;
}

function requestName(
  session: NamedLibrary,
  run: NamingRun,
  ref: Ref,
  lookup: typeof fetchDetails,
): Promise<void> {
  const id = titleKey(ref);
  let work = run.pending.get(id);
  if (!work) {
    work = Promise.resolve()
      .then(() => lookup(ref, run.key))
      .then((found) => {
        if (!found || runs.get(session) !== run) return;
        run.found.set(id, found);
        run.timer ??= setTimeout(() => publish(session, run), BATCH_MS);
      })
      .catch(() => {})
      .finally(() => run.pending.delete(id));
    run.pending.set(id, work);
  }
  return work;
}

/** Name an explicit bounded set, sharing requests and publishing one metadata batch per session. */
export async function nameLibraryTitles(
  session: NamedLibrary,
  refs: Ref[],
  key: string,
  lookup: typeof fetchDetails = fetchDetails,
): Promise<void> {
  const run = namingRun(session, key);
  const queue = [...new Map(refs.map((ref) => [titleKey(ref), ref])).values()];
  let next = 0;
  const worker = async () => {
    for (let ref = queue[next++]; ref; ref = queue[next++]) {
      if (runs.get(session) !== run) return;
      const id = titleKey(ref);
      if (
        run.found.has(id) ||
        (knownTitles(session, run).has(id) && (ref.type !== 'tv' || session.shapes.has(id)))
      )
        continue;
      await requestName(session, run, ref, lookup);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  publish(session, run);
}

/** A direct route or pointer intent is foreground work and joins an identical pending lookup. */
export function promoteLibraryTitle(
  session: NamedLibrary,
  ref: Ref,
  key: string,
  lookup: typeof fetchDetails = fetchDetails,
): Promise<void> {
  return nameLibraryTitles(session, [ref], key, lookup);
}
