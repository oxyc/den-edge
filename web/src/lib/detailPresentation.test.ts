import { describe, expect, it } from 'vitest';
import { groupFilmography, parseDetail, parseFilmography, parseSeason } from './detail';
import {
  airDate,
  calendarDate,
  cleanedOverview,
  episodeProgress,
  futureDate,
  parseRatings,
  productionFacts,
  seriesPresentation,
  titleFacts,
} from './detailPresentation';
import { readDetailPrefs } from './prefs';
import type { EpisodeRow, TitleRow } from './wire';

const ref = { type: 'tv' as const, id: 1 };
const detail = (extra: object = {}) =>
  parseDetail(ref, {
    name: 'A Series',
    first_air_date: '2020-03-03',
    seasons: [
      { season_number: 0, episode_count: 4 },
      { season_number: 1, episode_count: 3 },
      { season_number: 2, episode_count: 2 },
    ],
    last_episode_to_air: { season_number: 2, episode_number: 1 },
    ...extra,
  })!;
const ep = (season: number, episode: number, value: number, at = 10) =>
  ({
    kind: 'ep',
    title: ref,
    season,
    episode,
    progress: { value, at: [at, 0, 'test'], viewing: 1 },
  }) as EpisodeRow;
const row = (reset: number) =>
  ({ deleted: { value: false }, episodesReset: [reset, 0, 'test'] }) as TitleRow;

describe('detail presentation', () => {
  it('treats air dates as local calendar days, validates dates, and does not call today unaired', () => {
    expect(calendarDate('2026-02-31')).toBeUndefined();
    expect(calendarDate('not-a-date')).toBeUndefined();
    expect(airDate('2026-09-12', 'en-US')).toBe('Sep 12, 2026');
    expect(futureDate('2026-09-12', new Date(2026, 8, 12, 0))).toBe(false);
    expect(futureDate('2026-09-13', new Date(2026, 8, 12, 23))).toBe(true);
  });
  it('shows series year ranges and release dates, and only known production facts', () => {
    expect(titleFacts(detail({ status: 'Ended', last_air_date: '2023-01-01' }))).toEqual([
      '2020–2023',
      'Series',
    ]);
    expect(titleFacts(detail({ status: 'Returning Series' }))).toEqual(['2020–', 'Series']);
    expect(titleFacts(detail({ first_air_date: '2099-02-01' }), new Date(2026, 0, 1))[0]).toMatch(
      /^Airs /,
    );
    expect(
      productionFacts(
        detail({
          spoken_languages: [{ english_name: 'Swedish' }],
          production_countries: [{ name: 'Sweden' }],
          networks: [{ name: 'Netflix' }],
        }),
      ),
    ).toBe('Swedish · Sweden · Netflix');
  });
  it('includes episode runtime and strips redundant episode labels without deleting ordinary prose', () => {
    const e = parseSeason({
      episodes: [{ episode_number: 1, runtime: 51, overview: 'Episode 1: The search begins.' }],
    })[0]!;
    expect(e.runtime).toBe(51);
    expect(cleanedOverview(e)).toBe('The search begins.');
    expect(
      cleanedOverview({ number: 1, name: 'Pilot', overview: 'A mystery: nobody knows.' }),
    ).toBe('A mystery: nobody knows.');
  });
  it('honors reset stamps everywhere, including equal milliseconds with different counters', () => {
    expect(episodeProgress(ep(1, 1, 1), row(10))).toBe(0);
    const after = ep(1, 1, 0.5);
    after.progress.at = [10, 1, 'test'];
    expect(episodeProgress(after, row(10))).toBe(0.5);
    expect(episodeProgress(ep(1, 1, 1), { ...row(0), deleted: { value: true } } as TitleRow)).toBe(
      0,
    );
  });
  it('counts only aired regular episodes and resumes the latest played episode, not an old gap', () => {
    const episodes = new Map([
      ['1:2', ep(1, 2, 1, 5)],
      ['2:1', ep(2, 1, 0.4, 20)],
      ['0:1', ep(0, 1, 1, 30)],
    ]);
    expect(seriesPresentation(detail(), episodes)).toMatchObject({
      total: 4,
      watched: 1,
      target: { season: 2, episode: 1 },
      kind: 'resume',
      fraction: 0.4,
      initialSeason: 2,
    });
    expect(seriesPresentation(detail(), episodes, row(40))).toMatchObject({
      watched: 0,
      target: { season: 1, episode: 1 },
      kind: 'start',
    });
  });
  it('advances across seasons, never plays an unaired next episode and restarts after the aired finale', () => {
    expect(seriesPresentation(detail(), new Map([['1:3', ep(1, 3, 0.95)]]))).toMatchObject({
      target: { season: 2, episode: 1 },
      kind: 'next',
    });
    expect(
      seriesPresentation(
        detail(),
        new Map([
          ['1:1', ep(1, 1, 1)],
          ['1:2', ep(1, 2, 1)],
          ['1:3', ep(1, 3, 1)],
          ['2:1', ep(2, 1, 1)],
        ]),
      ),
    ).toMatchObject({ target: { season: 1, episode: 1 }, kind: 'start' });
    expect(seriesPresentation(detail({ first_air_date: '2099-01-01' }), new Map())).toMatchObject({
      total: 0,
      target: undefined,
    });
  });
  it('selects regional certification and streaming providers and puts directors before the cast', () => {
    const d = parseDetail(
      { type: 'movie', id: 1 },
      {
        title: 'Movie',
        credits: {
          crew: [
            { id: 4, name: 'Director', job: 'Director' },
            { id: 4, name: 'Director', job: 'Director' },
          ],
        },
        release_dates: {
          results: [
            { iso_3166_1: 'FI', release_dates: [{ certification: '12', type: 3 }] },
            { iso_3166_1: 'US', release_dates: [{ certification: 'PG-13', type: 3 }] },
          ],
        },
        'watch/providers': {
          results: {
            FI: {
              link: 'https://www.themoviedb.org/movie/1/watch',
              flatrate: [{ provider_id: 8, provider_name: 'Netflix', logo_path: '/n.png' }],
            },
          },
        },
      },
      'FI',
    )!;
    expect(d.certification).toBe('12');
    expect(d.providers.map((p) => p.name)).toEqual(['Netflix']);
    expect(d.directors).toHaveLength(1);
  });
  it('reads ratings without turning N/A into zero and respects intentionally disabled sources', () => {
    expect(parseRatings({ Response: 'False' })).toBeNull();
    expect(
      parseRatings({
        Response: 'True',
        imdbRating: 'N/A',
        imdbVotes: '1,250',
        Awards: 'N/A',
        Ratings: [
          { Source: 'Rotten Tomatoes', Value: '89%' },
          { Source: 'Metacritic', Value: '74/100' },
        ],
      }),
    ).toEqual({
      imdb: undefined,
      votes: 1250,
      rottenTomatoes: 89,
      metacritic: 74,
      awards: undefined,
    });
    expect(readDetailPrefs(undefined, 'fi-FI').region).toBe('FI');
    expect(
      readDetailPrefs({
        values: {
          'den.enabledRatingSources': { value: { strings: [] } },
          'den.autoplayTrailers': { value: { bool: false } },
        },
      } as never),
    ).toMatchObject({ ratingSources: [], autoplay: false });
  });
});

describe('full actor filmography', () => {
  it('keeps cameos, TV guest credits and production, deduplicates within each department and orders newest first', () => {
    const movie = (id: number, year: string) => ({
      id,
      media_type: 'movie',
      title: `Movie ${id}`,
      release_date: `${year}-01-01`,
    });
    const parsed = parseFilmography({
      cast: [
        { ...movie(1, '2020'), character: 'Self' },
        movie(2, '2025'),
        movie(2, '2025'),
        { id: 2, media_type: 'tv', name: 'Series', first_air_date: '2024-01-01', episode_count: 1 },
      ],
      crew: [
        { ...movie(1, '2020'), department: 'Production', job: 'Producer' },
        { ...movie(3, '2023'), department: 'Directing', job: 'Director' },
        { ...movie(4, '2021'), department: 'Sound' },
      ],
    });
    const groups = groupFilmography(parsed);
    expect(groups.map((g) => g.department)).toEqual(['Acting', 'Directing', 'Production', 'Sound']);
    expect(groups[0]!.films.map((c) => `${c.title.type}:${c.title.id}`)).toEqual([
      'movie:2',
      'tv:2',
      'movie:1',
    ]);
    expect(groups[2]!.films[0]!.title.id).toBe(1);
  });
});
