import { titleKey, type MediaType, type Shape, type Title } from './library';
import { fetchDetails } from './tmdb';

interface NamedLibrary {
  displays: Title[];
  shapes: Map<string, Shape>;
}
type Ref = { type: MediaType; id: number };
interface NamingRun {
  key: string;
  pending: Map<string, Promise<void>>;
}
// Retained pages share pending work; weak ownership releases it with the paired library.
const runs = new WeakMap<NamedLibrary, NamingRun>();

export async function nameLibraryTitles(
  session: NamedLibrary,
  refs: Ref[],
  key: string,
  lookup: typeof fetchDetails = fetchDetails,
): Promise<void> {
  let run = runs.get(session);
  if (!run || run.key !== key) {
    run = { key, pending: new Map() };
    runs.set(session, run);
  }
  const current = run;
  const queue = [...refs];
  const worker = async () => {
    for (let ref = queue.shift(); ref; ref = queue.shift()) {
      if (runs.get(session) !== current) return;
      const id = titleKey(ref);
      if (session.displays.some((title) => titleKey(title) === id)) continue;
      let work = current.pending.get(id);
      if (!work) {
        const requested = ref;
        work = Promise.resolve()
          .then(() => lookup(requested, key))
          .then((found) => {
            if (!found || runs.get(session) !== current) return;
            // A user action may have remembered this title while its metadata was loading.
            if (!session.displays.some((title) => titleKey(title) === id)) {
              session.displays = [...session.displays, found.title];
            }
            if (found.shape) session.shapes = new Map(session.shapes).set(id, found.shape);
          })
          .catch(() => {})
          .finally(() => current.pending.delete(id));
        current.pending.set(id, work);
      }
      await work;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}
