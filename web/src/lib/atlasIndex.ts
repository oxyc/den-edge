// atlas's index queries: the two POST routes that can answer for a whole pool at once.
//
// The catalogs name a title by id and year and nothing else, so nearly everything the billboard pools arrives
// unjudged, and the picker could only rank what TMDB had separately been asked about — sixty candidates out of
// nine hundred, chosen by attention before taste was ever consulted. These label the lot in two requests, and
// say which of them a "more like this" row would already have put in front of the viewer.
//
// They are POSTs only because the body is large; nothing is written, and nothing about the household is stored.

import type { MediaType } from './library';

/**
 * What atlas calls a series.
 *
 * Its own media types are `movie` and `series`; Den's are `movie` and `tv`. Sending Den's scores a silent zero
 * rather than an error — `{"type":"tv","id":1399}` answers 200 with `null` where `series` answers with the
 * labels — so every series would quietly look like a title atlas had never heard of.
 */
const atlasType = (type: MediaType) => (type === 'tv' ? 'series' : 'movie');

const denType = (type: string): MediaType => (type === 'series' ? 'tv' : 'movie');

/** Titles per request: atlas caps a POST body at 64 KiB, and five hundred ids is about fifteen. */
const BATCH = 500;
/** Seeds atlas takes at once. */
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

async function ask<T>(
  base: string,
  route: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<T | null> {
  try {
    const res = await fetchImpl(`${base}/index/${route}.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null; // atlas out of reach: the billboard falls back on what TMDB said
  }
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
  const found = new Map<string, Labels>();
  const unique = [...new Map(refs.map((ref) => [keyOf(ref), ref])).values()];
  for (let at = 0; at < unique.length; at += BATCH) {
    const batch = unique.slice(at, at + BATCH);
    const answer = await ask<{ labels: (Labels | null)[] }>(
      base,
      'labels',
      { titles: batch.map((ref) => ({ type: atlasType(ref.type), id: ref.id })) },
      fetchImpl,
    );
    // Positional: the nth label answers the nth title, and null means atlas has never seen it.
    (answer?.labels ?? []).forEach((label, at2) => {
      const ref = batch[at2];
      if (label && ref) found.set(keyOf(ref), label);
    });
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
  if (use.length === 0) return { seeds: 0, hits: new Map() };
  const answer = await ask<{ perSeed: { seed: { type: string; id: number }; ids: number[] }[] }>(
    base,
    'suggest',
    { seeds: use.map((ref) => ({ type: atlasType(ref.type), id: ref.id })) },
    fetchImpl,
  );
  if (!answer) return { seeds: 0, hits: new Map() };
  const hits = new Map<string, number>();
  for (const per of answer.perSeed ?? []) {
    // The ids come back bare, in the media type of the seed they answer.
    const type = denType(per.seed?.type ?? 'movie');
    for (const id of per.ids ?? []) {
      const key = keyOf({ type, id });
      hits.set(key, (hits.get(key) ?? 0) + 1);
    }
  }
  // Only seeds atlas could actually answer for count: it holds few series, and dividing by seeds that returned
  // nothing would read every title as less redundant than it is.
  const answered = (answer.perSeed ?? []).filter((per) => (per.ids ?? []).length > 0).length;
  return { seeds: answered, hits };
}
