import { describe, expect, it } from 'vitest';
import { buildHistoryExport, historyCsv, letterboxdCsv } from './historyExport';
import type { Title } from './library';
import type { DocumentRow, Stamp } from './wire';

const D = 'a1b2c3d4e5f60718';
const at = (t: number): Stamp => [t, 0, D];
const NOW = 1_800_000_000_000;
/** An imported play's key: its watchedAt − 2⁵³ (v3 §3). */
const importKey = (t: number) => String(t - 2 ** 53);

const film = (id: number, fields: Record<string, unknown>): DocumentRow => ({
  format: 4,
  kind: 'title',
  title: { type: 'movie', id },
  addedAt: 1_700_000_000_000,
  ...fields,
});

const watched = (t: number, viewing = 0) => ({
  status: { value: 'watched', at: at(t) },
  resume: { value: 1, at: at(t), viewing },
});

const register = (plays: Record<string, number>, progress?: [number, number]) => ({
  ...(progress ? { progress: { value: 1, at: at(progress[0]), viewing: progress[1] } } : {}),
  imported: false,
  plays,
  cleared: null,
});

const documents: DocumentRow[] = [
  // Seen three times: once in a tracker before Den, then twice in Den. Loved.
  film(550, {
    ...watched(1_789_000_000_000, 1),
    reaction: { value: 'love', at: at(1_789_000_100_000) },
    watch: {
      plays: {
        [importKey(1_700_000_000_000)]: 1_700_000_000_000,
        '0': 1_760_000_000_000,
        '1': 1_789_000_000_000,
      },
      cleared: null,
    },
  }),
  // Seen once; TMDB's name has a comma in it.
  film(146, {
    ...watched(1_750_000_000_000),
    watch: { plays: { '0': 1_750_000_000_000 }, cleared: null },
  }),
  // Seen once; TMDB couldn't name it.
  film(27205, {
    ...watched(1_770_000_000_000),
    watch: { plays: { '0': 1_770_000_000_000 }, cleared: null },
  }),
  // Started, never finished.
  film(238, {
    status: { value: 'inProgress', at: at(1_788_500_000_000) },
    resume: { value: 0.4, at: at(1_788_500_000_000), viewing: 0 },
  }),
  // On the watchlist, never seen.
  film(603, { status: { value: 'watchlist', at: at(1_788_000_000_000) } }),
  // Rated without a status.
  film(680, { reaction: { value: 'like', at: at(1_788_000_000_000) } }),
  // Seen, then un-watched: the play is cleared, so it's not history.
  film(13, {
    status: { value: 'none', at: at(1_785_000_000_000) },
    resume: { value: 0, at: at(1_785_000_000_000), viewing: 1 },
    watch: { plays: { '0': 1_784_000_000_000 }, cleared: [0, at(1_785_000_000_000)] },
  }),
  // Seen, then removed from the library.
  film(999, {
    ...watched(1_786_000_000_000),
    deleted: { value: true, at: at(1_787_000_000_000) },
    watch: { plays: { '0': 1_786_000_000_000 }, cleared: null },
  }),
  {
    format: 4,
    kind: 'title',
    title: { type: 'tv', id: 1399 },
    status: { value: 'watched', at: at(1_790_000_000_000) },
    reaction: { value: 'dislike', at: at(1_790_000_000_000) },
    addedAt: 1_779_000_000_000,
    episodesReset: null,
  },
  {
    format: 4,
    kind: 'season',
    title: { type: 'tv', id: 1399 },
    season: 1,
    seasonReset: null,
    episodes: {
      '1': register({ '0': 1_780_000_000_000 }, [1_780_000_000_000, 0]),
      // Seen, then seen again.
      '2': register({ '0': 1_781_000_000_000, '1': 1_790_000_000_000 }, [1_790_000_000_000, 1]),
      // Known seen from a tracker, with no date.
      '3': { imported: true, plays: {}, cleared: null },
    },
  },
  {
    format: 4,
    kind: 'season',
    title: { type: 'tv', id: 1399 },
    season: 0,
    seasonReset: null,
    episodes: { '1': register({ '0': 1_782_000_000_000 }, [1_782_000_000_000, 0]) },
  },
];

const named = (type: 'movie' | 'tv', id: number, title: string, year: number, imdbId: string) =>
  [`${type}:${id}`, { type, id, title, year, imdbId } as Title] as const;
const names = new Map([
  named('movie', 550, 'Fight Club', 1999, 'tt0137523'),
  named('movie', 146, 'Crouching Tiger, Hidden Dragon', 2000, 'tt0190332'),
  named('movie', 238, 'The Godfather', 1972, 'tt0068646'),
  named('movie', 603, 'The Matrix', 1999, 'tt0133093'),
  named('movie', 680, 'Pulp Fiction', 1994, 'tt0110912'),
  named('movie', 13, 'Forrest Gump', 1994, 'tt0109830'),
  named('tv', 1399, 'Game of Thrones', 2011, 'tt0944947'),
]);

const den = (watchedAt: string, rewatch = false) => ({ watchedAt, rewatch, source: 'den' });

describe('history export', () => {
  const history = buildHistoryExport(documents, names, NOW);

  it('holds every title with its state and every viewing, and leaves out what is not history', () => {
    expect(history).toEqual({
      format: 'den-history',
      version: 1,
      exportedAt: '2027-01-15T08:00:00.000Z',
      titles: [
        {
          type: 'movie',
          tmdbId: 146,
          imdbId: 'tt0190332',
          title: 'Crouching Tiger, Hidden Dragon',
          year: 2000,
          status: 'watched',
          watchlist: false,
          reaction: null,
          rating: null,
          addedAt: '2023-11-14T22:13:20.000Z',
          plays: [den('2025-06-15T15:06:40.000Z')],
        },
        {
          type: 'movie',
          tmdbId: 238,
          imdbId: 'tt0068646',
          title: 'The Godfather',
          year: 1972,
          status: 'inProgress',
          watchlist: false,
          reaction: null,
          rating: null,
          addedAt: '2023-11-14T22:13:20.000Z',
          plays: [],
        },
        {
          type: 'movie',
          tmdbId: 550,
          imdbId: 'tt0137523',
          title: 'Fight Club',
          year: 1999,
          status: 'watched',
          watchlist: false,
          reaction: 'love',
          rating: 10,
          addedAt: '2023-11-14T22:13:20.000Z',
          plays: [
            { watchedAt: '2023-11-14T22:13:20.000Z', rewatch: false, source: 'import' },
            den('2025-10-09T08:53:20.000Z', true),
            den('2026-09-10T00:26:40.000Z', true),
          ],
        },
        {
          type: 'movie',
          tmdbId: 603,
          imdbId: 'tt0133093',
          title: 'The Matrix',
          year: 1999,
          status: 'watchlist',
          watchlist: true,
          reaction: null,
          rating: null,
          addedAt: '2023-11-14T22:13:20.000Z',
          plays: [],
        },
        {
          type: 'movie',
          tmdbId: 680,
          imdbId: 'tt0110912',
          title: 'Pulp Fiction',
          year: 1994,
          status: 'none',
          watchlist: false,
          reaction: 'like',
          rating: 7,
          addedAt: '2023-11-14T22:13:20.000Z',
          plays: [],
        },
        {
          type: 'movie',
          tmdbId: 27205,
          imdbId: null,
          title: null,
          year: null,
          status: 'watched',
          watchlist: false,
          reaction: null,
          rating: null,
          addedAt: '2023-11-14T22:13:20.000Z',
          plays: [den('2026-02-02T02:40:00.000Z')],
        },
        {
          type: 'tv',
          tmdbId: 1399,
          imdbId: 'tt0944947',
          title: 'Game of Thrones',
          year: 2011,
          status: 'watched',
          watchlist: false,
          reaction: 'dislike',
          rating: 2,
          addedAt: '2026-05-17T06:40:00.000Z',
          episodes: [
            { season: 0, episode: 1, plays: [den('2026-06-21T00:00:00.000Z')] },
            { season: 1, episode: 1, plays: [den('2026-05-28T20:26:40.000Z')] },
            {
              season: 1,
              episode: 2,
              plays: [den('2026-06-09T10:13:20.000Z'), den('2026-09-21T14:13:20.000Z', true)],
            },
            {
              season: 1,
              episode: 3,
              plays: [{ watchedAt: null, rewatch: false, source: 'import' }],
            },
          ],
        },
      ],
    });
  });

  it('writes a line per viewing, newest first and the undated last, then each title with no viewing', () => {
    expect(historyCsv(history).split('\r\n')).toEqual([
      'kind,type,tmdb_id,imdb_id,title,year,season,episode,watched_at,rewatch,source,status,watchlist,reaction,rating',
      'watch,tv,1399,tt0944947,Game of Thrones,2011,1,2,2026-09-21T14:13:20.000Z,true,den,watched,false,dislike,2',
      'watch,movie,550,tt0137523,Fight Club,1999,,,2026-09-10T00:26:40.000Z,true,den,watched,false,love,10',
      'watch,tv,1399,tt0944947,Game of Thrones,2011,0,1,2026-06-21T00:00:00.000Z,false,den,watched,false,dislike,2',
      'watch,tv,1399,tt0944947,Game of Thrones,2011,1,2,2026-06-09T10:13:20.000Z,false,den,watched,false,dislike,2',
      'watch,tv,1399,tt0944947,Game of Thrones,2011,1,1,2026-05-28T20:26:40.000Z,false,den,watched,false,dislike,2',
      'watch,movie,27205,,,,,,2026-02-02T02:40:00.000Z,false,den,watched,false,,',
      'watch,movie,550,tt0137523,Fight Club,1999,,,2025-10-09T08:53:20.000Z,true,den,watched,false,love,10',
      'watch,movie,146,tt0190332,"Crouching Tiger, Hidden Dragon",2000,,,2025-06-15T15:06:40.000Z,false,den,watched,false,,',
      'watch,movie,550,tt0137523,Fight Club,1999,,,2023-11-14T22:13:20.000Z,false,import,watched,false,love,10',
      'watch,tv,1399,tt0944947,Game of Thrones,2011,1,3,,false,import,watched,false,dislike,2',
      'in_progress,movie,238,tt0068646,The Godfather,1972,,,,,,inProgress,false,,',
      'watchlist,movie,603,tt0133093,The Matrix,1999,,,,,,watchlist,true,,',
      'rating,movie,680,tt0110912,Pulp Fiction,1994,,,,,,none,false,like,7',
      '',
    ]);
  });

  it('writes the films in Letterboxd’s import columns, one line per viewing on its UTC day', () => {
    expect(letterboxdCsv(history).split('\r\n')).toEqual([
      'Title,Year,imdbID,tmdbID,WatchedDate,Rating10,Rewatch',
      'Fight Club,1999,tt0137523,550,2026-09-10,10,true',
      ',,,27205,2026-02-02,,false',
      'Fight Club,1999,tt0137523,550,2025-10-09,10,true',
      '"Crouching Tiger, Hidden Dragon",2000,tt0190332,146,2025-06-15,,false',
      'Fight Club,1999,tt0137523,550,2023-11-14,10,false',
      '',
    ]);
  });

  it('quotes a cell holding a quote', () => {
    const quoted = new Map([named('movie', 146, 'The "Best" Film', 2000, 'tt0190332')]);
    expect(historyCsv(buildHistoryExport(documents, quoted, NOW))).toContain(
      'watch,movie,146,tt0190332,"The ""Best"" Film",2000,',
    );
  });

  it('exports nothing from an empty library', () => {
    expect(historyCsv(buildHistoryExport([], names, NOW))).toBe(
      'kind,type,tmdb_id,imdb_id,title,year,season,episode,watched_at,rewatch,source,status,watchlist,reaction,rating\r\n',
    );
  });
});
