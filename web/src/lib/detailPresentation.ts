import type { Episode, TitleDetail } from './detail';
import { compareStamps, type EpisodeRow, type TitleRow } from './wire';

/** TMDB dates are calendar days, not UTC instants: midnight UTC displays yesterday in the Americas. */
export function calendarDate(value?: string): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y!, m! - 1, d!, 12);
  return date.getFullYear() === y && date.getMonth() === m! - 1 && date.getDate() === d
    ? date
    : undefined;
}

export function futureDate(value?: string, now = new Date()): boolean {
  const date = calendarDate(value);
  return (
    !!date &&
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() >
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  );
}

export function airDate(value?: string, locale?: string): string {
  return (
    calendarDate(value)?.toLocaleDateString(locale, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }) ?? ''
  );
}

export function cleanedOverview(episode: Episode): string {
  const overview = episode.overview ?? '';
  const colon = overview.indexOf(':');
  if (colon < 1 || colon > 50) return overview;
  const label = overview.slice(0, colon).trim().toLowerCase();
  const name = episode.name.trim().toLowerCase();
  const redundant =
    /season|episode|minisode|webisode|part|chapter|special/.test(label) ||
    (!!name && (label.includes(name) || name.includes(label)));
  return redundant ? overview.slice(colon + 1).trim() || overview : overview;
}

export function titleFacts(d: TitleDetail, now = new Date()): string[] {
  const upcoming = futureDate(d.title.releaseDate, now);
  let year = d.title.year ? String(d.title.year) : '';
  if (d.title.type === 'tv' && year) {
    const end = calendarDate(d.lastAirDate)?.getFullYear();
    if (d.status === 'Ended' || d.status === 'Canceled')
      year += end && end !== d.title.year ? `–${end}` : '';
    else year += '–';
  }
  return [
    upcoming
      ? `${d.title.type === 'tv' ? 'Airs' : 'Releases'} ${airDate(d.title.releaseDate)}`
      : year,
    d.runtime ? `${d.runtime} min` : '',
    d.title.type === 'tv' ? 'Series' : 'Movie',
  ].filter(Boolean);
}

export function productionFacts(d: TitleDetail): string {
  const money = (n: number) =>
    '$' + new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  return [
    d.languages.slice(0, 3).join(', '),
    d.countries.slice(0, 2).join(', '),
    d.revenue && d.revenue > 0
      ? `${money(d.revenue)} box office`
      : d.budget && d.budget > 0
        ? `${money(d.budget)} budget`
        : '',
    d.studios.slice(0, 2).join(', '),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** One reset-aware progress interpretation for the hero, episode rows and all playback actions. */
export function episodeProgress(episode: EpisodeRow | undefined, row?: TitleRow): number {
  if (
    !episode ||
    row?.deleted.value ||
    (row?.episodesReset && compareStamps(episode.progress.at, row.episodesReset) <= 0)
  )
    return 0;
  return Math.max(0, Math.min(1, episode.progress.value));
}

export function seriesPresentation(
  d: TitleDetail,
  episodes: Map<string, EpisodeRow>,
  row?: TitleRow,
) {
  const regular = d.seasons.filter((s) => s.number > 0);
  const aired = (s: number, e: number) =>
    !d.lastAired ||
    d.lastAired.season <= 0 ||
    s < d.lastAired.season ||
    (s === d.lastAired.season && e <= d.lastAired.episode);
  const coords = regular
    .flatMap((s) =>
      Array.from({ length: s.episodeCount }, (_, i) => ({ season: s.number, episode: i + 1 })),
    )
    .filter((c) => aired(c.season, c.episode) && !futureDate(d.title.releaseDate));
  const progress = (c: { season: number; episode: number }) =>
    episodeProgress(episodes.get(`${c.season}:${c.episode}`), row);
  const watched = coords.filter((c) => progress(c) >= 0.95).length;
  const latest = [...episodes.values()]
    .filter(
      (e) =>
        progress(e) > 0.02 && coords.some((c) => c.season === e.season && c.episode === e.episode),
    )
    .sort(
      (a, b) =>
        compareStamps(b.progress.at, a.progress.at) || b.season - a.season || b.episode - a.episode,
    )[0];
  const first = coords[0];
  let target = first;
  let fraction = 0;
  let kind: 'start' | 'resume' | 'next' = 'start';
  if (latest) {
    if (progress(latest) < 0.95) {
      target = { season: latest.season, episode: latest.episode };
      fraction = progress(latest);
      kind = 'resume';
    } else {
      const next =
        coords[
          coords.findIndex((c) => c.season === latest.season && c.episode === latest.episode) + 1
        ];
      if (next) {
        target = next;
        kind = 'next';
      }
    }
  }
  return {
    total: coords.length,
    watched,
    target,
    fraction,
    kind,
    initialSeason: latest?.season ?? d.seasons[0]?.number ?? null,
  };
}

export interface Ratings {
  imdb?: number;
  votes?: number;
  rottenTomatoes?: number;
  metacritic?: number;
  awards?: string;
}
export function parseRatings(body: Record<string, unknown>): Ratings | null {
  if (body.Response !== 'True') return null;
  const score = (value: unknown, max: number) => {
    if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) return undefined;
    const n = Number(value);
    return n >= 0 && n <= max ? n : undefined;
  };
  const ratings = (Array.isArray(body.Ratings) ? body.Ratings : []).filter(
    (r): r is { Source: string; Value: string } =>
      !!r && typeof r.Source === 'string' && typeof r.Value === 'string',
  );
  const rt = ratings.find((r) => r?.Source === 'Rotten Tomatoes')?.Value?.replace(/%$/, '');
  const mc = ratings.find((r) => r?.Source === 'Metacritic')?.Value?.replace(/\/100$/, '');
  return {
    imdb: score(body.imdbRating, 10),
    votes: score(String(body.imdbVotes ?? '').replaceAll(',', ''), Number.MAX_SAFE_INTEGER),
    rottenTomatoes: score(rt, 100),
    metacritic: score(mc, 100),
    awards:
      typeof body.Awards === 'string' && !['', 'N/A'].includes(body.Awards)
        ? body.Awards
        : undefined,
  };
}

export async function fetchRatings(
  imdb: string,
  key: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Ratings | null> {
  if (!key || !/^tt\d+$/.test(imdb)) return null;
  try {
    const url = new URL('https://www.omdbapi.com/');
    url.searchParams.set('i', imdb);
    url.searchParams.set('apikey', key);
    const res = await fetchImpl(url, { signal });
    return res.ok ? parseRatings(await res.json()) : null;
  } catch {
    return null;
  }
}
