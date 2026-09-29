import { describe, expect, it } from 'vitest';
import { markEpisode } from './actions';
import {
  dayFirst,
  findEpisode,
  normalize,
  parseCsv,
  parseTitle,
  plan,
  readDate,
  type Lookups,
  type SearchHit,
} from './netflixImport';
import { importJournals } from './netflixJournal';
import { trackerEvent } from './trackerEvents';
import { ZERO_STAMP, type EpisodeRow } from './wire';

const noon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();

describe('reading the file', () => {
  it('reads Netflix’s CSV, quotes and commas in titles included, without the header', () => {
    const csv =
      '﻿Title,Date\r\n"Friends: Season 4: The One with the ""Cuffs""",9/14/26\r\n"Hello, My Name Is Doris",9/12/26\r\n';
    expect(parseCsv(csv)).toEqual([
      { title: 'Friends: Season 4: The One with the "Cuffs"', date: '9/14/26' },
      { title: 'Hello, My Name Is Doris', date: '9/12/26' },
    ]);
  });

  it('reads a spreadsheet copy, tab-separated', () => {
    expect(parseCsv('Title\tDate\nOffice Romance\t9/12/26')).toEqual([
      { title: 'Office Romance', date: '9/12/26' },
    ]);
  });

  it('tells month-first dates from day-first ones by a number over 12', () => {
    expect(dayFirst(['9/1/26', '9/20/26'])).toBe(false);
    expect(dayFirst(['01/09/2026', '20/09/2026'])).toBe(true);
    expect(dayFirst(['1/2/26'])).toBe(false);
  });

  it('reads a date as local noon, a two-digit year as this century, and refuses an impossible one', () => {
    expect(readDate('9/20/26', false)).toBe(noon(2026, 9, 20));
    expect(readDate('20/09/2026', true)).toBe(noon(2026, 9, 20));
    expect(readDate('2026-09-20', false)).toBe(noon(2026, 9, 20));
    expect(readDate('2/30/26', false)).toBeNull();
    expect(readDate('yesterday', false)).toBeNull();
  });
});

describe('reading a title', () => {
  it('splits an episode at its season label, colons in the show’s name kept', () => {
    expect(parseTitle("Friends: Season 4: The One with Rachel's Crush")).toEqual({
      kind: 'episode',
      show: 'Friends',
      season: 4,
      episode: "The One with Rachel's Crush",
    });
    expect(parseTitle('Love Is Blind: UK: Season 3: The Reunion')).toEqual({
      kind: 'episode',
      show: 'Love Is Blind: UK',
      season: 3,
      episode: 'The Reunion',
    });
  });

  it('reads a limited series as its only season, and anything unlabelled as a name', () => {
    expect(parseTitle('Adolescence: Limited Series: Episode 2')).toMatchObject({
      show: 'Adolescence',
      season: 1,
      episode: 'Episode 2',
    });
    expect(parseTitle('Fito Páez: The World Within a Song')).toEqual({
      kind: 'name',
      name: 'Fito Páez: The World Within a Song',
    });
  });

  it('finds an episode by its name however it is punctuated, or by its number', () => {
    const episodes = [
      { number: 1, name: 'The One with the Jellyfish' },
      { number: 3, name: 'The One with the ’Cuffs' },
      { number: 7, name: 'The One Where They’re Going to Party!' },
    ];
    expect(findEpisode("The One with the 'Cuffs", episodes)).toBe(3);
    expect(findEpisode("The One Where They're Going to Party", episodes)).toBe(7);
    expect(findEpisode('Episode 1', episodes)).toBe(1);
    expect(findEpisode('The One with the Embryos', episodes)).toBeUndefined();
  });
});

describe('matching edge cases', () => {
  it('keeps letters of every script, so two different non-Latin names never read as equal', () => {
    expect(normalize('오징어 게임')).not.toBe('');
    expect(normalize('오징어 게임!')).toBe(normalize('오징어  게임'));
    expect(normalize('오징어 게임')).not.toBe(normalize('킹덤'));
    expect(normalize('Amélie')).toBe('amelie');
    expect(findEpisode('!!!', [{ number: 1, name: '???' }])).toBeUndefined();
  });

  it('reads a day-first file as day-first when every day is 12 or under, rather than dating it in the future', async () => {
    const lookups: Lookups = {
      searchTv: async () => [],
      searchMulti: async (q) => [{ type: 'movie', id: 1, name: q }],
      seasons: async () => [],
      episodes: async () => null,
    };
    // 10 March 2026, day-first; month-first it would be 3 October 2026 — still to come on 28 September.
    const { marks } = await withNow(new Date(2026, 8, 28, 9).getTime(), () =>
      plan([{ title: 'Office Romance', date: '10/03/2026' }], lookups),
    );
    expect(marks[0]!.at).toBe(noon(2026, 3, 10));
  });

  it('finds a show Netflix writes without a season label, searching for it once', async () => {
    let searches = 0;
    let filmSearches = 0;
    const lookups: Lookups = {
      searchTv: async (q) => {
        searches++;
        return q === 'Stranger Things' ? [{ type: 'tv', id: 66732, name: 'Stranger Things' }] : [];
      },
      searchMulti: async () => (filmSearches++, []),
      seasons: async () => [1, 4],
      episodes: async (_id, season) =>
        season === 4
          ? [
              { number: 1, name: 'Chapter One: The Hellfire Club' },
              { number: 2, name: 'Chapter Two: Vecna’s Curse' },
            ]
          : [],
    };
    const { marks, unmatched } = await plan(
      [
        {
          title: 'Stranger Things: Stranger Things 4: Chapter One: The Hellfire Club',
          date: '9/1/26',
        },
        { title: "Stranger Things: Stranger Things 4: Chapter Two: Vecna's Curse", date: '9/2/26' },
      ],
      lookups,
    );
    expect(unmatched).toEqual([]);
    expect(marks.map((m) => `S${m.season}E${m.episode}`).sort()).toEqual(['S4E1', 'S4E2']);
    expect(filmSearches).toBe(0);
    // "…Chapter One", "…Chapter Two" each once, the shared "Stranger Things: Stranger Things 4" and "Stranger
    // Things" once between them.
    expect(searches).toBe(4);
  });
});

async function withNow<T>(now: number, run: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => now;
  try {
    return await run();
  } finally {
    Date.now = real;
  }
}

describe('matching a history', () => {
  const friends: SearchHit = { type: 'tv', id: 1668, name: 'Friends' };
  const lookups: Lookups = {
    searchTv: async (q) => (q === 'Friends' ? [friends] : []),
    searchMulti: async (q) =>
      q === 'Office Romance' ? [{ type: 'movie', id: 1, name: 'Office Romance' }] : [],
    seasons: async () => [0, 1, 2, 3, 4],
    episodes: async (_id, season) =>
      season === 4
        ? [
            { number: 1, name: 'The One with the Jellyfish' },
            { number: 12, name: 'The One with the Embryos' },
          ]
        : season === 3
          ? [{ number: 25, name: 'The One at the Beach' }]
          : [],
  };

  it('marks each film and episode once, at its latest viewing, and lists what it couldn’t find', async () => {
    const result = await plan(
      [
        { title: 'Friends: Season 4: The One with the Embryos', date: '9/20/26' },
        { title: 'Friends: Season 4: The One with the Embryos', date: '9/1/26' },
        { title: 'Friends: Season 4: The One with the Jellyfish', date: '9/14/26' },
        // Netflix's season and TMDB's disagree: found in the season TMDB has it in.
        { title: 'Friends: Season 4: The One at the Beach', date: '9/12/26' },
        { title: 'Office Romance', date: '9/12/26' },
        { title: 'Fito Páez: The World Within a Song', date: '9/14/26' },
        { title: 'Friends: Season 4: The One Nobody Wrote', date: '9/14/26' },
        { title: 'Broken', date: 'soon' },
      ],
      lookups,
    );
    expect(result.marks).toEqual(
      expect.arrayContaining([
        { type: 'tv', id: 1668, name: 'Friends', season: 4, episode: 12, at: noon(2026, 9, 20) },
        { type: 'tv', id: 1668, name: 'Friends', season: 4, episode: 1, at: noon(2026, 9, 14) },
        { type: 'tv', id: 1668, name: 'Friends', season: 3, episode: 25, at: noon(2026, 9, 12) },
        { type: 'movie', id: 1, name: 'Office Romance', at: noon(2026, 9, 12) },
      ]),
    );
    expect(result.marks).toHaveLength(4);
    expect(result.unmatched.sort()).toEqual([
      'Fito Páez: The World Within a Song',
      'Friends: Season 4: The One Nobody Wrote',
    ]);
    expect(result.undated).toBe(1);
  });
});

describe('writing the marks', () => {
  const device = 'feedfacefeedface';
  const ep = (at: number): EpisodeRow =>
    markEpisode(
      {
        kind: 'ep',
        schema: 2,
        title: { type: 'tv', id: 1668 },
        season: 4,
        episode: 12,
        progress: { value: 0, at: ZERO_STAMP, viewing: 0 },
      },
      true,
      [at, 0, 'tv'],
    );

  it('journals each mark stamped with the day it was watched, which the TV sends Simkl as the date', () => {
    const at = noon(2026, 9, 20);
    const [journal, film] = importJournals(
      [
        { type: 'tv', id: 1668, name: 'Friends', season: 4, episode: 12, at },
        { type: 'movie', id: 1, name: 'Office Romance', at },
      ],
      { title: () => undefined, episode: () => undefined },
      device,
    );
    const event = trackerEvent(journal!)!;
    expect(event.at).toEqual([at, 0, device]);
    expect(event.after).toMatchObject({
      kind: 'ep',
      season: 4,
      episode: 12,
      progress: { value: 1 },
    });
    expect(trackerEvent(film!)!.after).toMatchObject({
      kind: 'rec',
      status: { value: 'watched', at: [at, 1, device] },
      watchedAt: at,
    });
  });

  it('writes nothing for a mark imported before, whatever its place in the file', () => {
    const at = noon(2026, 9, 20);
    const mark = { type: 'tv' as const, id: 1668, name: 'Friends', season: 4, episode: 12, at };
    const [first] = importJournals(
      [mark],
      { title: () => undefined, episode: () => undefined },
      device,
    );
    const imported = trackerEvent(first!)!.after as EpisodeRow;
    // The same file again, this mark now second: a higher counter on the same day.
    const other = { ...mark, episode: 13 };
    expect(
      importJournals(
        [other, mark],
        { title: () => undefined, episode: (_r, _s, e) => (e === 12 ? imported : undefined) },
        device,
      ),
    ).toHaveLength(1);
  });

  it('leaves out a mark older than what the library already says, and dates a newer one by Netflix', () => {
    const rows = (row: EpisodeRow) => ({ title: () => undefined, episode: () => row });
    const mark = {
      type: 'tv' as const,
      id: 1668,
      name: 'Friends',
      season: 4,
      episode: 12,
      at: noon(2026, 9, 20),
    };
    expect(importJournals([mark], rows(ep(noon(2026, 9, 25))), device)).toEqual([]);
    const newer = importJournals([mark], rows(ep(noon(2025, 1, 1))), device);
    expect(trackerEvent(newer[0]!)!.after).toMatchObject({
      progress: { at: [mark.at, 0, device] },
    });
  });
});
