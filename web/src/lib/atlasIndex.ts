// What atlas knows about titles, as the billboard reads it: their labels, and what it would offer as more like them.
//
// The catalogs name a title by id and year and nothing else, so nearly everything the billboard pools arrives
// unjudged, and the picker could only rank what TMDB had separately been asked about — sixty candidates out of
// nine hundred, chosen by attention before taste was ever consulted. atlas's labels judge the lot.
//
// Both are plain GETs a browser keeps. The labels are the dataset's own labels file — every title atlas holds, under
// a URL stamped with the dataset version — so a browser downloads it once per dataset (about 530 KB gzipped) and
// every visit after reads it from its cache without asking. More Like This is one GET per seed, cached like atlas's
// other index answers.

import type { MediaType } from './library';
import { loadLabels } from './labelsFile';
import type { LookupAnswer, LookupRequest } from './labelsWorker';

/**
 * What atlas calls a series.
 *
 * Its own media types are `movie` and `series`; Den's are `movie` and `tv`. Asking about `tv` finds nothing rather
 * than failing, so every series would quietly look like a title atlas had never heard of.
 */
const atlasType = (type: MediaType) => (type === 'tv' ? 'series' : 'movie');

/** Seeds asked about at once. */
const SEEDS = 8;

/** What atlas has labelled a title with. Confidences run 0…1. */
export interface Labels {
  primaryGenre?: string;
  animated?: boolean;
  subgenres: [string, number][];
  moods: [string, number][];
}

export interface Ref {
  type: MediaType;
  id: number;
}

const keyOf = (ref: Ref) => `${ref.type}:${ref.id}`;

async function getJson<T>(url: string, fetchImpl: typeof fetch): Promise<T | null> {
  try {
    const res = await fetchImpl(url);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null; // atlas out of reach: the billboard falls back on what TMDB said
  }
}

/** One load per atlas for the page's life, where there is no worker to read it; a failed one is dropped. */
const loads = new Map<string, Promise<Map<string, Labels> | null>>();

function loadHere(base: string, fetchImpl: typeof fetch): Promise<Map<string, Labels> | null> {
  const loading = loads.get(base);
  if (loading) return loading;
  const load = loadLabels(base, fetchImpl);
  loads.set(base, load);
  void load.then((all) => {
    if (!all) loads.delete(base);
  });
  return load;
}

let worker: Worker | null | undefined;
let asked = 0;
const waiting = new Map<number, (entries: [string, Labels][] | null) => void>();

/** The labels of `keys`, looked up by the worker that holds the parsed file; null where no worker could. */
function lookUpInWorker(base: string, keys: string[]): Promise<Map<string, Labels> | null> {
  if (worker === undefined) {
    try {
      worker = new Worker(new URL('./labelsWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }: MessageEvent<LookupAnswer>) => {
        waiting.get(data.id)?.(data.entries);
        waiting.delete(data.id);
      };
      worker.onerror = (event) => {
        console.warn('den: the labels worker failed', event.message);
        worker = null;
        for (const answer of waiting.values()) answer(null);
        waiting.clear();
      };
    } catch (error) {
      console.warn('den: no labels worker', error);
      worker = null;
    }
  }
  if (!worker) return Promise.resolve(null);
  const request: LookupRequest = { id: ++asked, base: new URL(base, location.href).href, keys };
  return new Promise((resolve) => {
    waiting.set(request.id, (entries) => resolve(entries && new Map(entries)));
    worker!.postMessage(request);
  });
}

/**
 * What atlas knows each of these titles to be — its subgenres and moods, which are the labels TMDB's nineteen
 * genres cannot express: "Crime" cannot tell Nordic noir from a slasher, `Police Procedural` and `Neo-Noir` can.
 *
 * Titles atlas has never indexed are simply absent, which is about a third of a typical pool and nearly every
 * series (it holds 3,892 of them). A caller must read a missing entry as "nothing known", never as "nothing in
 * common", or every unindexed title is marked down for atlas's gaps rather than for its own.
 */
export async function labelsFor(
  base: string,
  refs: Ref[],
  fetchImpl?: typeof fetch,
): Promise<Map<string, Labels>> {
  // The file is parsed on the worker's thread; a caller bringing its own fetch (the tests) reads it here instead.
  const all =
    !fetchImpl && typeof Worker !== 'undefined'
      ? await lookUpInWorker(base, refs.map(keyOf))
      : await loadHere(base, fetchImpl ?? fetch);
  const found = new Map<string, Labels>();
  for (const ref of refs) {
    const labels = all?.get(keyOf(ref));
    if (labels) found.set(keyOf(ref), labels);
  }
  return found;
}

/** How many of the library's own seeds each title is a near neighbour of, and how many seeds were asked. */
export interface Neighbourhood {
  seeds: number;
  /** By `type:id`, the number of seeds that returned it. Absent means no seed did. */
  hits: Map<string, number>;
}

/**
 * The library's own neighbourhood: for a handful of the titles this household has actually watched, what atlas
 * would offer as "more like this".
 *
 * Used to mark those answers *down* rather than up. A billboard is opened to find something not yet found, and
 * the nearest neighbours of what is already watched are the titles most likely to have been seen already, or to
 * have been recommended everywhere else, or to be found without any help. The rows below the billboard are where
 * "more like that" belongs.
 */
export async function neighbourhood(
  base: string,
  seeds: Ref[],
  fetchImpl: typeof fetch = fetch,
): Promise<Neighbourhood> {
  const use = [...new Map(seeds.map((ref) => [keyOf(ref), ref])).values()].slice(0, SEEDS);
  const answers = await Promise.all(
    use.map((seed) =>
      getJson<{ ids?: unknown }>(
        `${base}/index/similar/${atlasType(seed.type)}/${seed.id}.json`,
        fetchImpl,
      ),
    ),
  );
  const own = new Set(use.map(keyOf));
  const hits = new Map<string, number>();
  let answered = 0;
  answers.forEach((answer, at) => {
    const seed = use[at]!;
    // The ids come back bare, in the seed's own media type; the other seeds are not their neighbours to count.
    const keys = (Array.isArray(answer?.ids) ? answer.ids : [])
      .filter((id): id is number => typeof id === 'number')
      .map((id) => keyOf({ type: seed.type, id }))
      .filter((key) => !own.has(key));
    // Only seeds atlas could actually answer for count: it holds few series, and dividing by seeds that returned
    // nothing would read every title as less redundant than it is.
    if (keys.length) answered++;
    for (const key of keys) hits.set(key, (hits.get(key) ?? 0) + 1);
  });
  return { seeds: answered, hits };
}
