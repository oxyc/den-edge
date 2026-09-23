import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fetchCollection, fetchDetail, parseDetail, parsePerson, parseSeason } from './detail';
import { fetchDetails } from './tmdb';

const movie = {
  title: 'Arrival',
  release_date: '2016-11-11',
  poster_path: '/a.jpg',
  backdrop_path: '/b.jpg',
  overview: 'A linguist is recruited.',
  tagline: 'Why are they here?',
  runtime: 116,
  genres: [
    { id: 18, name: 'Drama' },
    { id: 878, name: 'Science Fiction' },
  ],
  credits: {
    cast: [
      { id: 1, name: 'Amy Adams', character: 'Louise', profile_path: '/p.jpg' },
      { id: 1, name: 'Amy Adams', character: 'Louise (older)' },
      { id: 2, name: 'Jeremy Renner', character: 'Ian' },
      { name: 'No id' },
    ],
  },
  recommendations: {
    results: [{ id: 27205, title: 'Inception', release_date: '2010-07-15' }, { id: 3 }],
  },
};

const series = {
  name: 'Severance',
  first_air_date: '2022-02-17',
  episode_run_time: [0, 55],
  seasons: [
    { season_number: 0, name: 'Specials', episode_count: 2 },
    { season_number: 2, name: 'Season 2', episode_count: 10 },
    { season_number: 1, name: 'Season 1', episode_count: 9 },
    { season_number: 3, name: 'Season 3', episode_count: 0 },
  ],
  aggregate_credits: { cast: [{ id: 5, name: 'Adam Scott', roles: [{ character: 'Mark S.' }] }] },
};

describe('title pages', () => {
  it('reads a movie: facts, cast once per person, and what TMDB recommends', () => {
    const detail = parseDetail({ type: 'movie', id: 329865 }, movie)!;
    expect(detail.title).toMatchObject({ title: 'Arrival', year: 2016, posterPath: '/a.jpg' });
    expect([detail.backdropPath, detail.tagline, detail.runtime, detail.genres]).toEqual([
      '/b.jpg',
      'Why are they here?',
      116,
      ['Drama', 'Science Fiction'],
    ]);
    expect(detail.cast).toEqual([
      { id: 1, name: 'Amy Adams', role: 'Louise', profilePath: '/p.jpg' },
      { id: 2, name: 'Jeremy Renner', role: 'Ian', profilePath: undefined },
    ]);
    expect(detail.more.map((t) => [t.type, t.id, t.title])).toEqual([
      ['movie', 27205, 'Inception'],
    ]);
    expect(detail.seasons).toEqual([]);
  });

  it('reads a series: seasons in order with Specials last, a role from each season, the usual episode length', () => {
    const detail = parseDetail({ type: 'tv', id: 95396 }, series)!;
    expect(detail.seasons.map((s) => s.number)).toEqual([1, 2, 0]);
    expect(detail.cast).toEqual([
      { id: 5, name: 'Adam Scott', role: 'Mark S.', profilePath: undefined },
    ]);
    expect(detail.runtime).toBe(55);
  });

  it('keeps the whole cast, for the page to reveal as it is scrolled, not the first twenty', () => {
    const long = {
      ...movie,
      credits: {
        cast: Array.from({ length: 45 }, (_, i) => ({ id: 100 + i, name: `Actor ${i}` })),
      },
    };
    const detail = parseDetail({ type: 'movie', id: 1 }, long)!;
    expect(detail.cast).toHaveLength(45);
    expect(detail.cast[44]).toMatchObject({ id: 144 });
  });

  it('refuses a title TMDB gives no name', () => {
    expect(parseDetail({ type: 'movie', id: 1 }, {})).toBeNull();
  });

  it('takes a YouTube trailer before a teaser, an official one before the rest, and nothing else', () => {
    const videos = (...results: object[]) =>
      parseDetail({ type: 'movie', id: 1 }, { ...movie, videos: { results } })!.trailer;
    const yt = (key: string, type: string, official = false) => ({
      site: 'YouTube',
      key,
      type,
      official,
    });
    expect(
      videos(yt('teaser', 'Teaser', true), yt('fan', 'Trailer'), yt('real', 'Trailer', true)),
    ).toBe('real');
    expect(videos(yt('teaser', 'Teaser'), { site: 'Vimeo', key: 'v', type: 'Trailer' })).toBe(
      'teaser',
    );
    expect(videos(yt('clip', 'Clip', true))).toBeUndefined();
    expect(parseDetail({ type: 'movie', id: 1 }, movie)!.trailer).toBeUndefined();
  });

  it('asks TMDB for the credits, recommendations, videos and external ids in the same fetch', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify(series), { status: 200 });
    }) as typeof fetch;
    expect(await fetchDetail({ type: 'tv', id: 95396 }, 'k', fetchImpl)).not.toBeNull();
    const url = new URL(asked[0]!);
    expect([url.pathname, url.searchParams.get('append_to_response')]).toEqual([
      '/3/tv/95396',
      'aggregate_credits,recommendations,videos,external_ids,content_ratings,watch/providers',
    ]);
    const down = (async () => new Response('{}', { status: 401 })) as typeof fetch;
    expect(await fetchDetail({ type: 'movie', id: 1 }, 'k', down)).toBeNull();
  });

  /**
   * den-edge answers every detail question for a title from one whole-detail fetch (`src/tmdb.rs`,
   * `MOVIE_APPENDS`/`TV_APPENDS`), but only for sub-requests on its list: one this app adds and that list
   * lacks is asked of TMDB on its own again, a miss per title per question.
   */
  it("asks only for what den-edge's whole detail carries", async () => {
    const source = readFileSync(new URL('../../../src/tmdb.rs', import.meta.url), 'utf8');
    const carried = (name: string) =>
      new Set(
        [
          ...(
            new RegExp(`const ${name}: \\[&str; \\d+\\] =\\s*\\[([^\\]]*)\\]`).exec(source)?.[1] ??
            ''
          ).matchAll(/"([^"]+)"/g),
        ].map((m) => m[1]),
      );
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify(series), { status: 200 });
    }) as typeof fetch;
    for (const type of ['movie', 'tv'] as const) {
      asked.length = 0;
      await fetchDetail({ type, id: 1 }, 'k', fetchImpl);
      await fetchDetails({ type, id: 1 }, 'k', fetchImpl);
      const whole = carried(type === 'movie' ? 'MOVIE_APPENDS' : 'TV_APPENDS');
      expect(whole.size, type).toBeGreaterThan(0);
      for (const url of asked)
        for (const append of new URL(url).searchParams.get('append_to_response')!.split(','))
          expect(whole.has(append), `${type}: ${append}`).toBe(true);
    }
  });
});

describe('seasons and people', () => {
  it("reads a season's episodes", () => {
    const episodes = parseSeason({
      episodes: [
        {
          episode_number: 1,
          name: 'Good News About Hell',
          still_path: '/s.jpg',
          air_date: '2022-02-18',
        },
        { episode_number: 2, name: '' },
        { name: 'No number' },
      ],
    });
    expect(episodes).toEqual([
      {
        number: 1,
        name: 'Good News About Hell',
        overview: undefined,
        stillPath: '/s.jpg',
        airDate: '2022-02-18',
      },
      {
        number: 2,
        name: 'Episode 2',
        overview: undefined,
        stillPath: undefined,
        airDate: undefined,
      },
    ]);
  });

  it('reads a person, and nobody without a name', () => {
    expect(
      parsePerson(287, {
        name: 'Brad Pitt',
        known_for_department: 'Acting',
        biography: 'An actor.',
      }),
    ).toEqual({
      id: 287,
      name: 'Brad Pitt',
      profilePath: undefined,
      biography: 'An actor.',
      knownFor: 'Acting',
    });
    expect(parsePerson(1, { biography: 'x' })).toBeNull();
  });

  it('orders a collection by complete release date instead of provider order within a year', async () => {
    const titles = await fetchCollection(
      12,
      'key',
      async () =>
        new Response(
          JSON.stringify({
            parts: [
              { id: 2, title: 'Later sequel', release_date: '2026-11-01' },
              { id: 3, title: 'Newer year only', release_date: '2027' },
              { id: 4, title: 'No date' },
              { id: 5, title: 'Alpha tie', release_date: '2026-02-01' },
              { id: 5, title: 'Alpha tie', release_date: '2026-02-01' },
              { id: 1, title: 'Earlier sequel', release_date: '2026-02-01' },
            ],
          }),
        ),
    );

    expect(titles.map((title) => title.title)).toEqual([
      'Alpha tie',
      'Earlier sequel',
      'Later sequel',
      'Newer year only',
      'No date',
    ]);
  });
});
