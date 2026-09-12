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

interface LabelsFile {
  records?: {
    tmdbId?: unknown;
    mediaType?: unknown;
    primaryGenre?: unknown;
    animated?: unknown;
    subgenres?: unknown;
    moods?: unknown;
  }[];
}

/** The labels file's `{label, confidence}` list as `[label, confidence]` pairs, as atlas's own answers give them. */
function pairs(list: unknown): [string, number][] {
  return Array.isArray(list)
    ? list.flatMap((entry: { label?: unknown; confidence?: unknown } | null) =>
        typeof entry?.label === 'string' && typeof entry.confidence === 'number'
          ? [[entry.label, entry.confidence] as [string, number]]
          : [],
      )
    : [];
}

/** One load per atlas for the page's life; a failed one is dropped, so the next caller asks again. */
const loads = new Map<string, Promise<Map<string, Labels> | null>>();

/** Every title's labels in the dataset atlas serves at `base`; null when atlas can't be reached. */
function allLabels(base: string, fetchImpl: typeof fetch): Promise<Map<string, Labels> | null> {
  const loading = loads.get(base);
  if (loading) return loading;
  const load = (async () => {
    const descriptor = await getJson<{ labels?: { url?: unknown } }>(
      `${base}/dataset.json`,
      fetchImpl,
    );
    const url = descriptor?.labels?.url;
    if (typeof url !== 'string') return null;
    // The descriptor names atlas's own address; this page asks atlas under its own origin, at `base`.
    const blob = new URL(url, 'https://atlas.invalid');
    const file = await getJson<LabelsFile>(`${base}${blob.pathname}${blob.search}`, fetchImpl);
    if (!Array.isArray(file?.records)) return null;
    const all = new Map<string, Labels>();
    for (const record of file.records) {
      const type =
        record.mediaType === 'movie'
          ? 'movie'
          : record.mediaType === 'tv' || record.mediaType === 'series'
            ? 'tv'
            : null;
      if (!type || typeof record.tmdbId !== 'number') continue;
      const key = keyOf({ type, id: record.tmdbId });
      if (all.has(key)) continue; // as atlas reads the file: the first row wins a duplicate
      all.set(key, {
        primaryGenre: typeof record.primaryGenre === 'string' ? record.primaryGenre : undefined,
        animated: record.animated === true,
        subgenres: pairs(record.subgenres),
        moods: pairs(record.moods),
      });
    }
    return all;
  })();
  loads.set(base, load);
  void load.then((all) => {
    if (!all) loads.delete(base);
  });
  return load;
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
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, Labels>> {
  const all = await allLabels(base, fetchImpl);
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
