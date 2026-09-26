import { RESUME_FLOOR, WATCHED } from './actions';
import type { Episode, TitleDetail } from './detail';
import type { Title } from './library';
import { relayFetch } from './relayFetch';
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

export interface PosterReleaseBadge {
  date: string;
  text: string;
  accessibilityLabel: string;
}

/** A compact future-date badge for a poster; a release today is already released. */
export function posterReleaseBadge(
  title: Pick<Title, 'type' | 'releaseDate'>,
  locale?: string,
  now = new Date(),
): PosterReleaseBadge | undefined {
  if (!futureDate(title.releaseDate, now)) return;
  const date = calendarDate(title.releaseDate)!;
  const text = date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  return {
    date: title.releaseDate!,
    text,
    accessibilityLabel: `${title.type === 'tv' ? 'Airs' : 'Releases'} ${airDate(title.releaseDate, locale)}`,
  };
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
    d.languages
      .slice(0, 3)
      .map((item) => item.name)
      .join(', '),
    d.countries
      .slice(0, 2)
      .map((item) => item.name)
      .join(', '),
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

/**
 * Which episodes of a season a season-wide control may write.
 *
 * Specials are none of them: season 0 is excluded from every count here and in the library, so marking it
 * writes rows nothing will ever show — a season that could be pressed and then read as untouched. Episodes
 * that have not aired are none of them either, or a season still going out could never read as watched
 * however much of it had been seen.
 */
export function markableEpisodes(
  season: number | null | undefined,
  episodes: readonly { number: number; airDate?: string }[] | null | undefined,
): number[] {
  if (season === null || season === undefined || season <= 0) return [];
  return (episodes ?? []).filter((e) => !futureDate(e.airDate)).map((e) => e.number);
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
  const watched = coords.filter((c) => progress(c) >= WATCHED).length;
  const latest = [...episodes.values()]
    .filter(
      (e) =>
        progress(e) > RESUME_FLOOR &&
        coords.some((c) => c.season === e.season && c.episode === e.episode),
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
    if (progress(latest) < WATCHED) {
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

/**
 * A title's IMDb, Rotten Tomatoes and Metacritic ratings, as den-edge keeps them for every device (`/ratings/imdb/<id>`,
 * in OMDb's own shape). This page's key, when it has one, only lets den-edge look up a title nobody has opened yet; a
 * member of the library is looked up with the household's (`relayFetch` proves membership).
 */
export async function fetchRatings(
  imdb: string,
  key: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = relayFetch,
): Promise<Ratings | null> {
  if (!/^tt\d+$/.test(imdb)) return null;
  try {
    const res = await fetchImpl(`/ratings/imdb/${imdb}`, {
      signal,
      headers: key ? { 'x-api-key': key } : {},
    });
    return res.ok ? parseRatings(await res.json()) : null;
  } catch {
    return null;
  }
}
