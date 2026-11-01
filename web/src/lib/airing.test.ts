import { describe, expect, it, vi } from 'vitest';
import dexter from '../../test/fixtures/airing-dexter.json';
import {
  AiringCache,
  NewEpisodes,
  RECHECK_MS,
  airedThrough,
  airingMaxAge,
  airingPath,
  comingBackSoon,
  continueAiringFacts,
  localDay,
  parseAiring,
  releasedEpisode,
  seriesStatusBadge,
  thisWeek,
  withAiring,
  withNewEpisodes,
  type Airing,
} from './airing';
import { airWindow } from './detailPresentation';
import type { Episode } from './detail';

/** Dexter: Resurrection as atlas answers it (TVmaze show 78665): S2E1 out on Paramount+ Fri 30 Oct. */
const DEXTER = 259909;
const airing = parseAiring(dexter)!;
/** TMDB's season 2, dated by the broadcaster's Sunday slot. */
const tmdbSeason: Episode[] = [
  { number: 1, name: 'Risky Business', airDate: '2026-11-01' },
  { number: 2, name: 'Young Blood', airDate: '2026-11-08' },
  { number: 3, name: 'Three', airDate: '2026-11-15' },
  { number: 4, name: 'Four', airDate: '2026-11-22' },
];
/** Saturday 31 Oct 2026, the day after the release, at noon local time. */
const saturday = new Date(2026, 9, 31, 12);

describe('one release date per episode', () => {
  it('dates S2E1 by TVmaze, so it is out on Oct 30 rather than TMDB’s Nov 1', () => {
    const episodes = withAiring(tmdbSeason, 2, airing);
    expect(episodes[0]).toMatchObject({ airDate: '2026-10-30', airService: 'Paramount+' });
    expect(airWindow(episodes[0]!.airDate, new Date(2026, 9, 30, 9))).toBe('aired');
    // On the Thursday before, TMDB's date alone would still have called it "near", not out.
    expect(airWindow(tmdbSeason[0]!.airDate, new Date(2026, 9, 30, 9))).toBe('near');
    expect(episodes[1]).toMatchObject({ airDate: '2026-11-06', airService: 'Paramount+' });
  });

  it('keeps TMDB’s date for episodes atlas does not date, and the list itself when it dates none', () => {
    expect(withAiring(tmdbSeason, 2, airing)[3]).toBe(tmdbSeason[3]);
    expect(withAiring(tmdbSeason, 1, airing)).toBe(tmdbSeason);
    expect(withAiring(tmdbSeason, 2, undefined)).toBe(tmdbSeason);
  });

  it('moves the newest aired episode forward to atlas’s, never back', () => {
    expect(airedThrough({ season: 1, episode: 10 }, airing, saturday)).toEqual({
      season: 2,
      episode: 1,
    });
    expect(airedThrough({ season: 1, episode: 10 }, airing, new Date(2026, 9, 29, 12))).toEqual({
      season: 1,
      episode: 10,
    });
    expect(airedThrough({ season: 2, episode: 4 }, airing, saturday)).toEqual({
      season: 2,
      episode: 4,
    });
    expect(airedThrough({ season: 1, episode: 10 }, undefined, saturday)).toEqual({
      season: 1,
      episode: 10,
    });
  });

  it('reads the status badge only from TVmaze', () => {
    expect(seriesStatusBadge(airing)).toBe('Returning');
    expect(seriesStatusBadge({ ...airing, status: 'ended' })).toBe('Ended');
    expect(seriesStatusBadge({ ...airing, source: 'tmdb', status: 'ended' })).toBeUndefined();
    expect(seriesStatusBadge(undefined)).toBeUndefined();
  });

  it('refuses malformed answers field by field', () => {
    const parsed = parseAiring({
      source: 'tvmaze',
      status: 'weird',
      service: '  ',
      next: { season: 2, episode: 2, date: 'Nov 6' },
      upcoming: [{ season: 2, episode: 3, date: '2026-11-13' }, null],
    });
    expect(parsed).toEqual({
      source: 'tvmaze',
      status: 'unknown',
      service: null,
      upcoming: [{ season: 2, episode: 3, date: '2026-11-13' }],
    });
    expect(parseAiring(null)).toBeUndefined();
  });

  it('asks atlas by TMDB id with the IMDb id as a hint', () => {
    expect(airingPath({ tmdb: DEXTER })).toBe('/airing/tv/259909');
    expect(airingPath({ tmdb: DEXTER, imdb: 'tt33043892' })).toBe(
      '/airing/tv/259909?imdb=tt33043892',
    );
  });
});

describe('AiringCache', () => {
  it('keeps each answer for its max-age, a 404 included, and asks only stale series', async () => {
    let now = 0;
    const cache = new AiringCache(() => now);
    const ask = vi.fn(async ({ tmdb }: { tmdb: number }) => ({
      airing: tmdb === DEXTER ? airing : null,
      maxAge: airingMaxAge('public, max-age=3600'),
    }));
    const first = await cache.lookup(
      '/atlas',
      [{ tmdb: DEXTER }, { tmdb: 7 }, { tmdb: DEXTER }],
      ask,
    );
    expect([...first!.keys()]).toEqual([DEXTER]);
    expect(ask).toHaveBeenCalledTimes(2);
    now = 3_599_000;
    await cache.lookup('/atlas', [{ tmdb: DEXTER }, { tmdb: 7 }], ask);
    expect(ask).toHaveBeenCalledTimes(2);
    now = 3_600_000;
    await cache.lookup('/atlas', [{ tmdb: DEXTER }], ask);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('joins a lookup already in flight and bounds how many are asked at once', async () => {
    const cache = new AiringCache();
    let inFlight = 0,
      most = 0;
    const ask = vi.fn(async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return { airing, maxAge: 3600 };
    });
    const series = Array.from({ length: 20 }, (_, i) => ({ tmdb: i + 1 }));
    const [a, b] = await Promise.all([
      cache.lookup('/atlas', series, ask),
      cache.lookup('/atlas', series, ask),
    ]);
    expect(ask).toHaveBeenCalledTimes(20);
    expect(most).toBeLessThanOrEqual(6);
    expect(a!.size).toBe(20);
    expect(b!.size).toBe(20);
  });

  it('falls back to TMDB (null) when atlas fails and nothing is held, and keeps what it held', async () => {
    let now = 0;
    const cache = new AiringCache(() => now);
    const failing = async () => {
      throw new Error('offline');
    };
    expect(await cache.lookup('/atlas', [{ tmdb: DEXTER }], failing)).toBeNull();
    await cache.lookup('/atlas', [{ tmdb: DEXTER }], async () => ({ airing, maxAge: 60 }));
    now = 120_000;
    const stale = await cache.lookup('/atlas', [{ tmdb: DEXTER }], failing);
    expect(stale!.get(DEXTER)).toEqual(airing);
  });

  it('reads max-age from Cache-Control and defaults to atlas’s hour', () => {
    expect(airingMaxAge('public, max-age=3600')).toBe(3600);
    expect(airingMaxAge(null)).toBe(3600);
    expect(airingMaxAge('max-age=1')).toBe(60);
    // A 404 whose first lookup is still running.
    expect(airingMaxAge('no-store')).toBe(0);
  });

  it('asks again on the next pass for a series atlas is still looking up', async () => {
    const cache = new AiringCache(() => 0);
    const ask = vi
      .fn()
      .mockResolvedValueOnce({ airing: null, maxAge: airingMaxAge('no-store') })
      .mockResolvedValueOnce({ airing, maxAge: 21_600 });
    expect((await cache.lookup('/atlas', [{ tmdb: DEXTER }], ask))!.size).toBe(0);
    expect((await cache.lookup('/atlas', [{ tmdb: DEXTER }], ask))!.get(DEXTER)).toEqual(airing);
  });

  it('reads atlas’s nulls as absent', () => {
    expect(
      parseAiring({
        source: 'tvmaze',
        status: 'ended',
        service: null,
        next: null,
        previous: { season: 3, episode: 8, name: null, date: '2024-05-01' },
        upcoming: [],
        seasonPremiere: null,
      }),
    ).toEqual({
      source: 'tvmaze',
      status: 'ended',
      service: null,
      previous: { season: 3, episode: 8, date: '2024-05-01' },
      upcoming: [],
    });
  });

  it('counts an episode due today as out, while atlas still calls it next', () => {
    const releaseDay = new Date(2026, 10, 6, 9);
    expect(releasedEpisode(airing, releaseDay)).toMatchObject({ season: 2, episode: 2 });
    expect(airedThrough({ season: 2, episode: 1 }, airing, releaseDay)).toEqual({
      season: 2,
      episode: 2,
    });
    // Out today is still this week's, as the Apple apps list it (`NewEpisodePolicy.thisWeek`).
    expect(thisWeek(new Map([[DEXTER, airing]]), releaseDay)).toMatchObject([
      { series: DEXTER, season: 2, episode: 2, date: '2026-11-06' },
    ]);
  });
});

describe('new episodes', () => {
  it('is the newest episode out within a fortnight', () => {
    expect(releasedEpisode(airing, saturday)).toMatchObject({ season: 2, episode: 1 });
    expect(releasedEpisode(airing, new Date(2026, 9, 29, 12))).toBeUndefined();
    expect(releasedEpisode(airing, new Date(2026, 10, 10, 12))).toMatchObject({ episode: 2 });
    expect(releasedEpisode(airing, new Date(2026, 10, 21, 12))).toMatchObject({ episode: 3 });
    expect(releasedEpisode(airing, new Date(2026, 10, 28, 12))).toBeUndefined();
    expect(releasedEpisode(airing, new Date(2027, 0, 1, 12))).toBeUndefined();
  });

  it('searches for sources at most every half hour until found, then holds it until cleared', () => {
    let now = 0;
    const news = new NewEpisodes(() => now);
    const episode = { series: DEXTER, season: 2, episode: 1 };
    expect(news.due(episode)).toBe(true);
    news.checked(episode, 0);
    expect(news.has(episode)).toBe(false);
    now = RECHECK_MS - 1;
    expect(news.due(episode)).toBe(false);
    now = RECHECK_MS;
    expect(news.due(episode)).toBe(true);
    news.checked(episode, null);
    expect(news.has(episode)).toBe(false);
    now = 2 * RECHECK_MS;
    news.checked(episode, 3);
    expect(news.has(episode)).toBe(true);
    expect(news.due(episode)).toBe(false);
    news.clear(episode);
    expect(news.has(episode)).toBe(false);
  });

  it('leads Continue Watching with the series, marked new', () => {
    const other = { title: { type: 'movie', id: 1 }, fraction: 0.4 };
    const caughtUp = {
      title: { type: 'tv', id: DEXTER },
      fraction: 0,
      episode: { season: 1, episode: 10 },
    };
    const news = [{ series: DEXTER, season: 2, episode: 1 }];
    expect(withNewEpisodes([other, caughtUp], news, () => undefined)).toEqual([
      { ...caughtUp, episode: { season: 2, episode: 1 }, isNew: true },
      other,
    ]);
    // Not in Continue Watching yet: TMDB had not dated it out, so the library saw nothing to continue.
    expect(
      withNewEpisodes([other], news, (one) => ({
        title: { type: 'tv', id: one.series },
        fraction: 0,
        episode: { season: one.season, episode: one.episode },
      })),
    ).toEqual([
      {
        title: { type: 'tv', id: DEXTER },
        fraction: 0,
        episode: { season: 2, episode: 1 },
        isNew: true,
      },
      other,
    ]);
    const list = [other];
    expect(withNewEpisodes(list, [], () => undefined)).toBe(list);
  });

  it('is no longer waiting once the episode it waited for is new', () => {
    const waiting = {
      title: { type: 'tv', id: DEXTER },
      fraction: 0,
      episode: { season: 2, episode: 2 },
      upcoming: '2026-11-06',
    };
    expect(
      withNewEpisodes([waiting], [{ series: DEXTER, season: 2, episode: 2 }], () => undefined),
    ).toEqual([
      { title: waiting.title, fraction: 0, episode: { season: 2, episode: 2 }, isNew: true },
    ]);
  });
});

describe('Continue Watching’s release dates', () => {
  it('hands the policy every dated episode, the viewer’s day and whether the series ended', () => {
    const facts = continueAiringFacts(new Map([[DEXTER, airing]]), saturday);
    expect(facts.today).toBe('2026-10-31');
    expect(facts.series).toHaveLength(1);
    expect(facts.series[0]).toMatchObject({ title: { type: 'tv', id: DEXTER }, ended: false });
    expect(facts.series[0]!.episodes).toContainEqual({ season: 2, episode: 2, date: '2026-11-06' });
    expect(
      continueAiringFacts(new Map([[DEXTER, { ...airing, status: 'ended' as const }]]), saturday)
        .series[0]!.ended,
    ).toBe(true);
  });

  it('dates a season premiere as its first episode', () => {
    const premiere: Airing = {
      source: 'tvmaze',
      status: 'running',
      service: null,
      upcoming: [],
      seasonPremiere: { season: 3, date: '2026-11-03' },
    };
    expect(continueAiringFacts(new Map([[1, premiere]]), saturday).series[0]!.episodes).toEqual([
      { season: 3, episode: 1, date: '2026-11-03' },
    ]);
  });

  it('counts the day where the viewer is', () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('Home rows', () => {
  const returning: Airing = {
    source: 'tvmaze',
    status: 'running',
    service: 'Netflix',
    upcoming: [],
    seasonPremiere: { season: 3, date: '2026-11-20' },
  };
  it('lists series coming back within a month and episodes due this week', () => {
    const airings = new Map([
      [DEXTER, airing],
      [9, returning],
      [10, { ...returning, seasonPremiere: { season: 4, date: '2027-02-01' } }],
    ]);
    expect(comingBackSoon(airings, saturday)).toEqual([
      { series: 9, season: 3, date: '2026-11-20' },
    ]);
    expect(thisWeek(airings, saturday)).toEqual([
      { series: DEXTER, season: 2, episode: 2, name: 'Young Blood', date: '2026-11-06' },
    ]);
  });
});
