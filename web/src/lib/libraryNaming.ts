import { titleKey, type Library, type MediaType, type Shape, type Title } from './library';
import type { Row, TitleRow } from './wire';
import { fetchDetails, type Details } from './tmdb';

interface NamedLibrary {
  displays: Title[];
  shapes: Map<string, Shape>;
}
type Ref = { type: MediaType; id: number };
interface NamingRun {
  key: string;
  pending: Map<string, Promise<void>>;
  /** Found but not yet published: every assignment re-derives the whole Home, so names land together. */
  found: Map<string, Details>;
  timer?: ReturnType<typeof setTimeout>;
}
// Retained pages share pending work; weak ownership releases it with the paired library.
const runs = new WeakMap<NamedLibrary, NamingRun>();
/** How long found names gather before they are published together. */
const BATCH_MS = 100;

/** Every name found since the last publish, in one assignment each to `displays` and `shapes`. */
function publish(session: NamedLibrary, run: NamingRun): void {
  clearTimeout(run.timer);
  run.timer = undefined;
  const found = [...run.found];
  run.found.clear();
  if (runs.get(session) !== run || !found.length) return;
  // A user action may have remembered a title while its metadata was loading.
  const known = new Set(session.displays.map(titleKey));
  const titles = found.filter(([id]) => !known.has(id)).map(([, details]) => details.title);
  if (titles.length) session.displays = [...session.displays, ...titles];
  const shapes = found.flatMap(([id, { shape }]) => (shape ? [[id, shape] as const] : []));
  if (shapes.length) session.shapes = new Map([...session.shapes, ...shapes]);
}

export async function nameLibraryTitles(
  session: NamedLibrary,
  refs: Ref[],
  key: string,
  lookup: typeof fetchDetails = fetchDetails,
): Promise<void> {
  let run = runs.get(session);
  if (!run || run.key !== key) {
    run = { key, pending: new Map(), found: new Map() };
    runs.set(session, run);
  }
  const current = run;
  const queue = [...refs];
  const worker = async () => {
    for (let ref = queue.shift(); ref; ref = queue.shift()) {
      if (runs.get(session) !== current) return;
      const id = titleKey(ref);
      if (
        current.found.has(id) ||
        (session.displays.some((title) => titleKey(title) === id) &&
          (ref.type !== 'tv' || session.shapes.has(id)))
      )
        continue;
      let work = current.pending.get(id);
      if (!work) {
        const requested = ref;
        work = Promise.resolve()
          .then(() => lookup(requested, key))
          .then((found) => {
            if (!found || runs.get(session) !== current) return;
            current.found.set(id, found);
            current.timer ??= setTimeout(() => publish(session, current), BATCH_MS);
          })
          .catch(() => {})
          .finally(() => current.pending.delete(id));
        current.pending.set(id, work);
      }
      await work;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  publish(session, current);
}

/** Select by log recency before looking up names: network order must never select the recommendation seeds. */
export function personalSeedRows(rows: Row[]) {
  const titles = rows.filter((r): r is TitleRow => r.kind === 'rec' && !r.deleted.value);
  const recency = (r: TitleRow) => Math.max(r.watchedAt ?? 0, r.reaction.at[0], r.addedAt);
  const latest = (keep: (r: TitleRow) => boolean) =>
    titles
      .filter(keep)
      .sort((a, b) => recency(b) - recency(a) || titleKey(a.title).localeCompare(titleKey(b.title)))
      .slice(0, 2);
  return {
    watched: latest(
      (r) =>
        r.status.value === 'watched' || r.reaction.value === 'like' || r.reaction.value === 'love',
    ),
    watchlisted: latest((r) => r.status.value === 'watchlist'),
  };
}

/** Only titles that can determine a visible shelf; older watched history can be named afterward. */
export function shelfTitleRefs(library: Library, rows: Row[]): Ref[] {
  const seeds = personalSeedRows(rows);
  const refs: Ref[] = [...seeds.watched, ...seeds.watchlisted].map((r) => r.title);
  refs.push(
    ...library.records
      .filter((r) => !r.deleted && (r.status === 'watchlist' || r.status === 'inProgress'))
      .map((r) => r.title),
  );
  refs.push(
    ...library.marks.filter(
      (m): m is typeof m & { type: 'tv' | 'movie' } => m.type === 'tv' || m.type === 'movie',
    ),
  );
  return [...new Map(refs.map((ref) => [titleKey(ref), { type: ref.type, id: ref.id }])).values()];
}
