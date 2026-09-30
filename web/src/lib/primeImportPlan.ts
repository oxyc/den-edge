import { WATCHED } from './actions';
import type { PrimeViewing } from './primeImport';
import {
  normalizeViewingName as normalize,
  type ImportShow,
  type ViewingEpisode,
  type ViewingLookups,
  type ViewingMark,
  type ViewingSearchHit,
} from './viewingImport';
import { findViewingEpisode } from './viewingImportMatch';

export interface PrimeImportPlan {
  marks: ViewingMark[];
  shows: Record<number, ImportShow>;
  unmatched: string[];
  ambiguous: string[];
  incomplete: { title: string; fraction: number }[];
  unknownDuration: string[];
  known: number;
}

interface EpisodeMatch {
  hit: ViewingSearchHit;
  show: ImportShow;
  season: number;
  episode: ViewingEpisode;
}

/**
 * Resolve Prime's safe observations to TMDB identities and retain only completed viewings. Completion uses Prime's
 * duration first, then TMDB's runtime; an uncertain partial or duration-less play is reported, never marked seen.
 */
export async function planPrimeImport(
  viewings: readonly PrimeViewing[],
  lookups: ViewingLookups,
  progress?: (done: number, total: number) => void,
  seen: (ref: { type: 'movie' | 'tv'; id: number }) => boolean = () => false,
): Promise<PrimeImportPlan> {
  const marks = new Map<string, ViewingMark>();
  const shows: Record<number, ImportShow> = {};
  const unmatched: string[] = [];
  const ambiguous: string[] = [];
  const incomplete: { title: string; fraction: number }[] = [];
  const unknownDuration: string[] = [];
  let known = 0;
  let done = 0;

  const searches = new Map<string, Promise<ViewingSearchHit[]>>();
  const search = (type: 'movie' | 'tv', query: string) => {
    const key = `${type}:${normalize(query)}`;
    if (!searches.has(key)) {
      const request =
        type === 'tv'
          ? lookups.searchTv(query)
          : lookups.searchMulti(query).then((hits) => hits.filter((hit) => hit.type === 'movie'));
      searches.set(key, request);
    }
    return searches.get(key)!;
  };
  const showCache = new Map<number, Promise<ImportShow | null>>();
  const showOf = (id: number) => {
    if (!showCache.has(id)) showCache.set(id, lookups.show(id));
    return showCache.get(id)!;
  };
  const episodeCache = new Map<string, Promise<ViewingEpisode[] | null>>();
  const episodesOf = (id: number, season: number) => {
    const key = `${id}:${season}`;
    if (!episodeCache.has(key)) episodeCache.set(key, lookups.episodes(id, season));
    return episodeCache.get(key)!;
  };
  const runtimeCache = new Map<string, Promise<number | null>>();
  const runtimeOf = (type: 'movie' | 'tv', id: number) => {
    if (!lookups.runtime) return Promise.resolve(null);
    const key = `${type}:${id}`;
    if (!runtimeCache.has(key)) runtimeCache.set(key, lookups.runtime(type, id));
    return runtimeCache.get(key)!;
  };

  const add = (mark: ViewingMark) => {
    const key = `${mark.type}:${mark.id}:${mark.season ?? ''}:${mark.episode ?? ''}`;
    const previous = marks.get(key);
    if (!previous || previous.at < mark.at) marks.set(key, mark);
  };
  const completion = async (
    viewing: PrimeViewing,
    fallbackMinutes: number | null | undefined,
  ): Promise<'complete' | 'incomplete' | 'unknown'> => {
    const duration =
      viewing.durationSeconds ?? (fallbackMinutes ? fallbackMinutes * 60 : undefined);
    if (!duration || duration <= 0) {
      unknownDuration.push(viewing.rawTitle);
      return 'unknown';
    }
    const fraction = viewing.watchedSeconds / duration;
    if (fraction < WATCHED) {
      incomplete.push({ title: viewing.rawTitle, fraction: Math.max(0, fraction) });
      return 'incomplete';
    }
    return 'complete';
  };

  await pool(viewings, 12, async (viewing) => {
    try {
      if (viewing.kind === 'movie') {
        const candidates = exact(await search('movie', viewing.title), viewing.title);
        if (candidates.length !== 1) {
          (candidates.length ? ambiguous : unmatched).push(viewing.rawTitle);
          return;
        }
        const hit = candidates[0]!;
        if (seen({ type: 'movie', id: hit.id })) {
          known++;
          return;
        }
        const fallback =
          viewing.durationSeconds === undefined ? await runtimeOf('movie', hit.id) : null;
        if ((await completion(viewing, fallback)) !== 'complete') return;
        add({
          type: 'movie',
          id: hit.id,
          name: hit.name,
          ...(hit.year ? { year: hit.year } : {}),
          source: viewing.title,
          at: viewing.watchedAt,
        });
        return;
      }

      if (!viewing.show) {
        unmatched.push(viewing.rawTitle);
        return;
      }
      const hits = exact(await search('tv', viewing.show), viewing.show).slice(0, 4);
      if (!hits.length) {
        unmatched.push(viewing.rawTitle);
        return;
      }
      const possible = (
        await Promise.all(hits.map((hit) => matchEpisode(viewing, hit, showOf, episodesOf)))
      ).flat();
      const unique = uniqueEpisodes(possible);
      if (unique.length !== 1) {
        (unique.length ? ambiguous : unmatched).push(viewing.rawTitle);
        return;
      }
      const match = unique[0]!;
      if (seen({ type: 'tv', id: match.hit.id })) {
        known++;
        return;
      }
      if ((await completion(viewing, match.episode.runtime)) !== 'complete') return;
      shows[match.hit.id] = match.show;
      add({
        type: 'tv',
        id: match.hit.id,
        name: match.hit.name,
        ...(match.hit.year ? { year: match.hit.year } : {}),
        source: viewing.show,
        season: match.season,
        episode: match.episode.number,
        at: viewing.watchedAt,
      });
    } finally {
      progress?.(++done, viewings.length);
    }
  });

  return {
    marks: [...marks.values()],
    shows,
    unmatched,
    ambiguous,
    incomplete,
    unknownDuration,
    known,
  };
}

async function matchEpisode(
  viewing: PrimeViewing,
  hit: ViewingSearchHit,
  showOf: (id: number) => Promise<ImportShow | null>,
  episodesOf: (id: number, season: number) => Promise<ViewingEpisode[] | null>,
): Promise<EpisodeMatch[]> {
  const show = await showOf(hit.id);
  if (!show) return [];
  const seasons =
    viewing.season !== undefined
      ? [viewing.season]
      : [...show.counts.keys()].filter((season) => season > 0);
  const found = (
    await Promise.all(
      seasons.map(async (season): Promise<EpisodeMatch | null> => {
        const episodes = await episodesOf(hit.id, season);
        if (!episodes) return null;
        const number = findViewingEpisode(viewing.title, episodes);
        const episode = episodes.find((candidate) => candidate.number === number);
        return episode ? { hit, show, season, episode } : null;
      }),
    )
  ).flatMap((match) => (match ? [match] : []));
  return found;
}

function exact(hits: readonly ViewingSearchHit[], query: string): ViewingSearchHit[] {
  const wanted = normalize(query);
  return hits.filter(
    (hit) => normalize(hit.name) === wanted || normalize(hit.originalName ?? '') === wanted,
  );
}

function uniqueEpisodes(matches: readonly EpisodeMatch[]): EpisodeMatch[] {
  const byKey = new Map<string, EpisodeMatch>();
  for (const match of matches)
    byKey.set(`${match.hit.id}:${match.season}:${match.episode.number}`, match);
  return [...byKey.values()];
}

async function pool<T>(items: readonly T[], width: number, run: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) await run(items[next++]!);
    }),
  );
}
