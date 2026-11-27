import { describe, expect, it, vi } from 'vitest';
import dexter from '../../test/fixtures/airing-dexter.json';
import {
  AiringCache,
  NewEpisodes,
  RECHECK_MS,
  airedThrough,
  airingMaxAge,
  airingPath,
  continueAiringFacts,
  localDay,
  newEpisodesRequest,
  parseAiring,
  parseAiringBatch,
  seriesStatusBadge,
  withAiring,
  withNewEpisodes,
  type Airing,
  type AiringAnswer,
  type AiringSeries,
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
  /** An asker answering every series it is given with `answer(tmdb)`, as atlas's `POST /airing` does. */
  const answering = (answer: (tmdb: number) => AiringAnswer | undefined) =>
    vi.fn(async (stale: AiringSeries[]) => {
      const answers = new Map<number, AiringAnswer>();
      for (const { tmdb } of stale) {
        const one = answer(tmdb);
        if (one) answers.set(tmdb, one);
      }
      return answers;
    });

  it('keeps each answer for its max-age, a 404 included, and asks only stale series, all at once', async () => {
    let now = 0;
    const cache = new AiringCache(() => now);
    const ask = answering((tmdb) => ({
      airing: tmdb === DEXTER ? airing : null,
      maxAge: tmdb === DEXTER ? 3600 : 619_200,
    }));
    const first = await cache.lookup(
      '/atlas',
      [{ tmdb: DEXTER }, { tmdb: 7 }, { tmdb: DEXTER }],
      ask,
    );
    expect([...first!.keys()]).toEqual([DEXTER]);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![0]).toEqual([{ tmdb: DEXTER }, { tmdb: 7 }]);
    now = 3_599_000;
    await cache.lookup('/atlas', [{ tmdb: DEXTER }, { tmdb: 7 }], ask);
    expect(ask).toHaveBeenCalledTimes(1);
    now = 3_600_000;
    await cache.lookup('/atlas', [{ tmdb: DEXTER }, { tmdb: 7 }], ask);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1]![0], 'the settled series is still fresh').toEqual([{ tmdb: DEXTER }]);
  });

  it('joins a lookup already in flight, asking each series once', async () => {
    const cache = new AiringCache();
    const ask = vi.fn(async (stale: AiringSeries[]) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return new Map(stale.map(({ tmdb }) => [tmdb, { airing, maxAge: 3600 }]));
    });
    const series = Array.from({ length: 20 }, (_, i) => ({ tmdb: i + 1 }));
    const [a, b] = await Promise.all([
      cache.lookup('/atlas', series, ask),
      cache.lookup('/atlas', series, ask),
    ]);
    expect(ask).toHaveBeenCalledTimes(1);
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
    await cache.lookup(
      '/atlas',
      [{ tmdb: DEXTER }],
      answering(() => ({ airing, maxAge: 60 })),
    );
    now = 120_000;
    const stale = await cache.lookup('/atlas', [{ tmdb: DEXTER }], failing);
    expect(stale!.get(DEXTER)).toEqual(airing);
  });

  it('reads max-age from Cache-Control and defaults to atlas’s hour', () => {
    expect(airingMaxAge('public, max-age=3600')).toBe(3600);
    expect(airingMaxAge(null)).toBe(3600);
    expect(airingMaxAge('max-age=1')).toBe(60);
    // A settled series is kept for days, as atlas says, up to ten.
    expect(airingMaxAge('public, max-age=619200')).toBe(619_200);
    expect(airingMaxAge('public, max-age=99999999')).toBe(864_000);
    // A 404 whose first lookup is still running.
    expect(airingMaxAge('no-store')).toBe(0);
  });

  it('asks again on the next pass for a series atlas is still looking up', async () => {
    const cache = new AiringCache(() => 0);
    const ask = vi
      .fn()
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(new Map([[DEXTER, { airing, maxAge: 21_600 }]]));
    expect((await cache.lookup('/atlas', [{ tmdb: DEXTER }], ask))!.size).toBe(0);
    expect((await cache.lookup('/atlas', [{ tmdb: DEXTER }], ask))!.get(DEXTER)).toEqual(airing);
  });

  it('reads atlas’s batch: each answer with its freshness, a pending one left to ask again', () => {
    const answers = parseAiringBatch({
      airing: [
        { tmdb: DEXTER, maxAge: 21_600, airing: dexter },
        { tmdb: 1396, maxAge: 619_200, airing: null },
        { tmdb: 2, pending: true },
        { tmdb: -1, maxAge: 60, airing: null },
        { tmdb: 3, maxAge: 60, airing: 'nonsense' },
      ],
    });
    expect([...answers.keys()]).toEqual([DEXTER, 1396]);
    expect(answers.get(DEXTER)).toEqual({ airing, maxAge: 21_600 });
    expect(answers.get(1396)).toEqual({ airing: null, maxAge: 619_200 });
    expect(parseAiringBatch(null).size).toBe(0);
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
    expect(airedThrough({ season: 2, episode: 1 }, airing, releaseDay)).toEqual({
      season: 2,
      episode: 2,
    });
  });
});

describe('new episodes', () => {
  it('throttles only authoritative answers, coalesces claims, and rejects abandoned late answers', () => {
    let now = 0;
    const news = new NewEpisodes(() => now);
    const episode = { series: DEXTER, season: 2, episode: 1 };
    const empty = news.claim(episode)!;
    expect(news.claim(episode)).toBeNull();
    expect(news.settle(empty, 0)).toBe(true);
    expect(news.has(episode)).toBe(false);
    now = RECHECK_MS - 1;
    expect(news.claim(episode)).toBeNull();
    now = RECHECK_MS;
    const failed = news.claim(episode)!;
    expect(news.settle(failed)).toBe(true);
    const abandoned = news.claim(episode)!;
    news.retain();
    expect(news.settle(abandoned, 3)).toBe(false);
    expect(news.has(episode)).toBe(false);

    const found = news.claim(episode)!;
    expect(news.settle(found, 3)).toBe(true);
    expect(news.has(episode)).toBe(true);
    expect(news.claim(episode)).toBeNull();
    news.clear(episode);
    expect(news.has(episode)).toBe(false);
  });

  it('releases a settling claim when its episode disappears', () => {
    const news = new NewEpisodes();
    const kept = { series: DEXTER, season: 2, episode: 1 };
    const gone = { series: DEXTER + 1, season: 1, episode: 4 };
    const keptClaim = news.claim(kept)!;
    const goneClaim = news.claim(gone)!;

    news.retain([kept]);

    expect(news.owns(keptClaim)).toBe(true);
    expect(news.owns(goneClaim)).toBe(false);
    expect(news.claim(gone)).not.toBeNull();
  });

  it('leads Continue Watching with each new episode’s series, its entry as the library offers it', () => {
    const other = { title: { type: 'movie', id: 1 }, fraction: 0.4 };
    // A season out at once, season 1 finished: the library offers S2E1 while the newest out is S2E10.
    const caughtUp = {
      title: { type: 'tv', id: DEXTER },
      fraction: 0,
      episode: { season: 2, episode: 1 },
    };
    const news = [{ series: DEXTER, season: 2, episode: 10 }];
    expect(withNewEpisodes([other, caughtUp], news)).toEqual([{ ...caughtUp, isNew: true }, other]);
    // A series not on the row is not added.
    expect(withNewEpisodes([other], news)).toEqual([other]);
    const list = [other];
    expect(withNewEpisodes(list, [])).toBe(list);
  });

  it('is no longer waiting once the episode it waited for is new', () => {
    const waiting = {
      title: { type: 'tv', id: DEXTER },
      fraction: 0,
      episode: { season: 2, episode: 2 },
      upcoming: '2026-11-06',
    };
    expect(withNewEpisodes([waiting], [{ series: DEXTER, season: 2, episode: 2 }])).toEqual([
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

describe('new-episode request', () => {
  const none = { watchlist: [], continuing: [], caughtUp: [], seen: [], dismissed: [] };

  it('hands den-core the facts, the dates held for every series they name, and the viewer’s day', () => {
    const request = newEpisodesRequest(
      {
        ...none,
        watchlist: [9, 0],
        continuing: [
          {
            series: DEXTER,
            episode: { season: 2, episode: 1 },
            upcoming: false,
            fraction: 1.2,
            watched: false,
          },
        ],
        dismissed: [7],
      },
      new Map<number, Airing>([
        [DEXTER, airing],
        [1416, airing],
      ]),
      saturday,
    );
    expect(request.today).toBe('2026-10-31');
    expect(request.watchlist, 'no series id is 0').toEqual([9]);
    expect(request.continuing).toEqual([
      { series: DEXTER, season: 2, episode: 1, upcoming: false, fraction: 1, watched: false },
    ]);
    expect(request.dismissed).toEqual([7]);
    // Only the dates of a series the facts name; 1416 is held for a title page.
    expect(request.airing.map(({ series }) => series)).toEqual([DEXTER]);
    expect(request.airing[0]).toMatchObject({
      previous: airing.previous,
      next: airing.next,
      upcoming: airing.upcoming,
      premiere: airing.seasonPremiere,
    });
  });
});
