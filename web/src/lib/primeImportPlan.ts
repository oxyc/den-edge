import type { PrimeViewing } from './primeImport';
import {
  normalizeViewingName as normalize,
  type ImportShow,
  type ViewingEpisode,
  type ViewingLookups,
  type ViewingMark,
  type ViewingSearchHit,
} from './viewingImport';
import { findViewingEpisode, unnamedViewingEpisode } from './viewingImportMatch';

export interface PrimeImportPlan {
  marks: ViewingMark[];
  shows: Record<number, ImportShow>;
  unmatched: string[];
  ambiguous: string[];
  known: number;
}

interface EpisodeMatch {
  hit: ViewingSearchHit;
  show: ImportShow;
  season: number;
  episode: ViewingEpisode;
}

interface PendingSeason {
  viewing: PrimeViewing;
  hit: ViewingSearchHit;
  show: ImportShow;
  reason: 'unmatched' | 'ambiguous';
}

/**
 * Resolve Prime's safe observations to TMDB identities. Every play in Watch Events is viewing history, regardless
 * of how much Prime says was watched; this deliberately matches the Netflix import's semantics.
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
  const pendingSeasons: PendingSeason[] = [];
  const unnamedSeries: PrimeViewing[] = [];
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
  const add = (mark: ViewingMark) => {
    const key = `${mark.type}:${mark.id}:${mark.season ?? ''}:${mark.episode ?? ''}`;
    const previous = marks.get(key);
    if (!previous || previous.at < mark.at) marks.set(key, mark);
  };
  await pool(viewings, 12, async (viewing) => {
    try {
      if (viewing.kind === 'movie') {
        const dated = /^(.*\S)\s*\((\d{4})\)$/.exec(viewing.title);
        const clean = (dated?.[1] ?? viewing.title)
          .replace(/\s*\((?:4k|uhd|hd)[^)]*\)\s*$/i, '')
          .trim();
        const queries = [clean];
        const colon = clean.indexOf(': ');
        if (colon >= 4) queries.push(clean.slice(0, colon));
        let candidates: ViewingSearchHit[] = [];
        for (const query of queries) {
          candidates = exact(await search('movie', query), query);
          if (candidates.length) break;
        }
        const watchedYear =
          viewing.watchedAt >= Date.UTC(2000, 0)
            ? new Date(viewing.watchedAt).getUTCFullYear()
            : Infinity;
        const hit = candidates.find(
          (candidate) =>
            (!dated || !candidate.year || candidate.year === Number(dated[2])) &&
            (!candidate.year || candidate.year <= watchedYear),
        );
        if (!hit) {
          (candidates.length ? ambiguous : unmatched).push(viewing.rawTitle);
          return;
        }
        if (seen({ type: 'movie', id: hit.id })) {
          known++;
          return;
        }
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
      if (/^season \d+$/i.test(normalize(viewing.show))) {
        unnamedSeries.push(viewing);
        return;
      }
      const searched = await search('tv', viewing.show);
      const namesakes = exact(searched, viewing.show).slice(0, 4);
      const hits = (namesakes.length ? namesakes : searched.slice(0, 4)).filter(
        (hit) =>
          !hit.year ||
          viewing.watchedAt < Date.UTC(2000, 0) ||
          hit.year <= new Date(viewing.watchedAt).getUTCFullYear(),
      );
      if (!hits.length || (!namesakes.length && unnamedViewingEpisode(viewing.title))) {
        unmatched.push(viewing.rawTitle);
        return;
      }
      const possible = (
        await Promise.all(hits.map((hit) => matchEpisode(viewing, hit, showOf, episodesOf)))
      ).flat();
      const unique = uniqueEpisodes(possible);
      let chosen: EpisodeMatch | undefined;
      if (namesakes.length) {
        for (const hit of hits) {
          const forHit = unique.filter((match) => match.hit.id === hit.id);
          if (forHit.length > 1) break;
          if (forHit.length === 1) {
            chosen = forHit[0];
            break;
          }
        }
      } else if (unique.length === 1) chosen = unique[0];
      if (!chosen) {
        const hit = hits[0];
        const show = hit && viewing.season !== undefined ? await showOf(hit.id) : null;
        if (hit && show && viewing.season !== undefined)
          pendingSeasons.push({
            viewing,
            hit,
            show,
            reason: unique.length ? 'ambiguous' : 'unmatched',
          });
        else (unique.length ? ambiguous : unmatched).push(viewing.rawTitle);
        return;
      }
      const match = chosen;
      if (seen({ type: 'tv', id: match.hit.id })) {
        known++;
        return;
      }
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

  const seasonGroups = new Map<string, PendingSeason[]>();
  for (const pending of pendingSeasons) {
    const key = `${pending.hit.id}:${pending.viewing.season}`;
    seasonGroups.set(key, [...(seasonGroups.get(key) ?? []), pending]);
  }
  for (const group of seasonGroups.values()) {
    const season = group[0]!.viewing.season!;
    const episodes = await episodesOf(group[0]!.hit.id, season);
    const distinct = new Set(group.map(({ viewing }) => normalize(viewing.rawTitle)));
    if (!episodes || group.length !== episodes.length || distinct.size !== group.length) {
      for (const pending of group)
        (pending.reason === 'ambiguous' ? ambiguous : unmatched).push(pending.viewing.rawTitle);
      continue;
    }
    const ordered = [...group].sort(
      (left, right) => left.viewing.watchedAt - right.viewing.watchedAt,
    );
    const slots = [...episodes].sort((left, right) => left.number - right.number);
    for (const [at, pending] of ordered.entries()) {
      const episode = slots[at]!;
      if (seen({ type: 'tv', id: pending.hit.id })) {
        known++;
        continue;
      }
      shows[pending.hit.id] = pending.show;
      add({
        type: 'tv',
        id: pending.hit.id,
        name: pending.hit.name,
        ...(pending.hit.year ? { year: pending.hit.year } : {}),
        source: pending.viewing.show!,
        season,
        episode: episode.number,
        at: pending.viewing.watchedAt,
      });
    }
  }

  const unnamedGroups = new Map<string, PrimeViewing[]>();
  for (const viewing of unnamedSeries) {
    const key = `${normalize(viewing.show!)}:${viewing.season}`;
    unnamedGroups.set(key, [...(unnamedGroups.get(key) ?? []), viewing]);
  }
  for (const group of unnamedGroups.values()) {
    const season = group[0]!.season;
    if (season === undefined) {
      unmatched.push(...group.map((viewing) => viewing.rawTitle));
      continue;
    }
    const candidates = new Map<number, ViewingSearchHit>();
    for (const viewing of group)
      for (const hit of exact(await search('tv', viewing.title), viewing.title))
        if (!hit.year || hit.year <= new Date(viewing.watchedAt).getUTCFullYear())
          candidates.set(hit.id, hit);
    const verified: { hit: ViewingSearchHit; show: ImportShow; episodes: ViewingEpisode[] }[] = [];
    for (const hit of candidates.values()) {
      const [show, episodes] = await Promise.all([showOf(hit.id), episodesOf(hit.id, season)]);
      if (!show || !episodes) continue;
      const numbers = group.map((viewing) => {
        const found = new Set(
          episodeNames(viewing).flatMap((name) => {
            const number = findViewingEpisode(name, episodes);
            return number === undefined ? [] : [number];
          }),
        );
        if (!found.size && season === 1 && normalize(viewing.title) === normalize(hit.name))
          found.add(1);
        return found.size === 1 ? [...found][0] : undefined;
      });
      if (numbers.every((number) => number !== undefined) && new Set(numbers).size === group.length)
        verified.push({ hit, show, episodes });
    }
    if (verified.length !== 1) {
      (verified.length ? ambiguous : unmatched).push(...group.map((viewing) => viewing.rawTitle));
      continue;
    }
    const { hit, show, episodes } = verified[0]!;
    for (const viewing of group) {
      const matched = episodeNames(viewing)
        .map((name) => findViewingEpisode(name, episodes))
        .find((found) => found !== undefined);
      const number =
        matched ??
        (season === 1 && normalize(viewing.title) === normalize(hit.name) ? 1 : undefined);
      if (number === undefined) continue;
      if (seen({ type: 'tv', id: hit.id })) {
        known++;
        continue;
      }
      shows[hit.id] = show;
      add({
        type: 'tv',
        id: hit.id,
        name: hit.name,
        ...(hit.year ? { year: hit.year } : {}),
        source: hit.name,
        season,
        episode: number,
        at: viewing.watchedAt,
      });
    }
  }

  return {
    marks: [...marks.values()],
    shows,
    unmatched,
    ambiguous,
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
        const aired = episodes.filter(
          (episode) =>
            !episode.airDate || Date.parse(episode.airDate) <= viewing.watchedAt + 86_400_000,
        );
        const numbers = new Set(
          episodeNames(viewing).flatMap((name) => {
            const number = findViewingEpisode(name, aired);
            return number === undefined ? [] : [number];
          }),
        );
        const number = numbers.size === 1 ? [...numbers][0] : undefined;
        const episode = aired.find((candidate) => candidate.number === number);
        return episode ? { hit, show, season, episode } : null;
      }),
    )
  ).flatMap((match) => (match ? [match] : []));
  return found;
}

function episodeNames(viewing: PrimeViewing): string[] {
  const names = [viewing.title];
  const show = normalize(viewing.show ?? '');
  for (const match of viewing.rawTitle.matchAll(/[-–—]/g)) {
    const suffix = normalize(viewing.rawTitle.slice(match.index! + 1));
    if (!suffix.startsWith(show)) continue;
    const raw = viewing.rawTitle.slice(0, match.index).trim();
    if (raw) names.push(raw);
    break;
  }
  for (const name of [...names]) {
    const direct =
      viewing.show && name.toLocaleLowerCase().startsWith(viewing.show.toLocaleLowerCase())
        ? name
            .slice(viewing.show.length)
            .replace(/^\s*[-–—:]\s*/, '')
            .trim()
        : '';
    if (direct) names.push(direct);
  }
  return [...new Set(names)];
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
