import { describe, expect, it } from 'vitest';
import { markEpisode } from './actions';
import {
  dayFirst,
  filmKey,
  findEpisode,
  joined,
  normalize,
  parseCsv,
  parseTitle,
  plan,
  readDate,
  type Lookups,
  type SearchHit,
  type Show,
} from './netflixImport';
import { importWrites, type Rows, type Writes } from './netflixJournal';
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
    expect(parseTitle("Friends: Season 4: The One with Rachel's Crush")).toMatchObject({
      kind: 'episode',
      show: 'Friends',
      season: 4,
      episode: "The One with Rachel's Crush",
    });
    expect(parseTitle('Love Is Blind: UK: Season 3: The Reunion')).toMatchObject({
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
      show: async () => null,
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
      show: async () => shape({ 1: 8, 4: 9 }),
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
    // "Stranger Things 4" is read as the show's fourth season, so the show is searched for once.
    expect(searches).toBe(1);
  });
});

const shape = (
  counts: Record<number, number>,
  lastAired?: { season: number; episode: number },
): Show => ({
  counts: new Map(Object.entries(counts).map(([s, n]) => [Number(s), n])),
  ...(lastAired ? { lastAired } : {}),
});

describe('what a real history needed', () => {
  it('reads the labels Netflix uses beyond "Season N", and never "Chapter" as a season', () => {
    expect(parseTitle('Love Is Blind: S10: Ohio: Um, Redo!')).toMatchObject({
      show: 'Love Is Blind',
      season: 10,
    });
    expect(parseTitle('The OA: Part II: Chapter 8: Overview')).toMatchObject({
      show: 'The OA',
      season: 2,
    });
    expect(parseTitle('3%: Season 1: Chapter 01: Cubes')).toMatchObject({
      show: '3%',
      season: 1,
      episode: 'Chapter 01: Cubes',
    });
    expect(parseTitle('Stranger Things: Stranger Things 2: Chapter Five: Dig Dug')).toMatchObject({
      show: 'Stranger Things',
      season: 2,
    });
  });

  it('finds two-parters, a trailing "The", a part alone, and a name only nearly the same', () => {
    const grey = [
      { number: 1, name: 'Dream a Little Dream of Me (1)' },
      { number: 2, name: 'Dream a Little Dream of Me (2)' },
      { number: 3, name: 'Here Comes the Flood' },
    ];
    expect(findEpisode('Dream A Little Dream Of Me: Part 2', grey)).toBe(2);
    expect(findEpisode('Dream A Little Dream Of Me, Pt. 1', grey)).toBe(1);
    const kardashians = [
      { number: 9, name: 'The Kardashian Chainsaw Massacre' },
      { number: 10, name: 'Other' },
    ];
    expect(findEpisode('Kardashian Chainsaw Massacre, The', kardashians)).toBe(9);
    const sinner = [
      { number: 1, name: 'Part I' },
      { number: 2, name: 'Part II' },
    ];
    expect(findEpisode('Cora: Part II', sinner)).toBe(2);
    const friends = [
      { number: 7, name: "The One with Ross's Library Book" },
      { number: 8, name: 'The One Where Chandler Doesn’t Like Dogs' },
    ];
    expect(findEpisode("The One with Ross' Library Book", friends)).toBe(7);
    expect(findEpisode('The One with the Wedding Dresses', friends)).toBeUndefined();
  });

  it('leaves out trailers and previews, which are no viewing', async () => {
    const result = await plan(
      [
        { title: 'Valeria: Season 1 Trailer: Valeria', date: '9/1/26' },
        { title: 'Personal Shopper: Personal Shopper_hook_primary_16x9', date: '9/1/26' },
      ],
      {
        searchTv: async () => [],
        searchMulti: async () => [],
        show: async () => null,
        episodes: async () => null,
      },
    );
    expect(result).toMatchObject({ marks: [], unmatched: [] });
  });

  it('takes the namesake whose episodes the history names, not TMDB’s first nor one with only "Episode N"', async () => {
    const original = { type: 'tv' as const, id: 12998, name: 'Heartbreak High' };
    const reboot = { type: 'tv' as const, id: 158154, name: 'Heartbreak High' };
    const lookups: Lookups = {
      searchTv: async () => [original, reboot],
      searchMulti: async () => [],
      show: async () => shape({ 1: 2 }),
      episodes: async (id) =>
        id === original.id
          ? [
              { number: 1, name: 'Episode 1' },
              { number: 2, name: 'Episode 2' },
            ]
          : [
              { number: 1, name: 'Map B**ch' },
              { number: 2, name: 'Three of Swords' },
            ],
    };
    const { marks } = await plan(
      [
        { title: 'Heartbreak High: Season 1: Map B**ch', date: '9/1/26' },
        { title: 'Heartbreak High: Season 1: Three of Swords', date: '9/2/26' },
      ],
      lookups,
    );
    expect(marks.map((m) => m.id)).toEqual([158154, 158154]);
  });

  it('places episodes TMDB names only "Episode N" in the order they were watched', async () => {
    const lookups: Lookups = {
      searchTv: async () => [{ type: 'tv', id: 254721, name: 'Kaulitz & Kaulitz' }],
      searchMulti: async () => [],
      show: async () => shape({ 3: 3 }),
      episodes: async () => [1, 2, 3].map((n) => ({ number: n, name: `Episode ${n}` })),
    };
    const { marks } = await plan(
      [
        { title: 'Kaulitz & Kaulitz: Season 3: The Dream Wedding', date: '9/3/26' },
        { title: 'Kaulitz & Kaulitz: Season 3: The Lost Prom', date: '9/1/26' },
        { title: 'Kaulitz & Kaulitz: Season 3: Twins in Pool Position', date: '9/2/26' },
      ],
      lookups,
    );
    const bySource = Object.fromEntries(marks.map((m) => [m.at, m.episode]));
    expect(bySource).toEqual({
      [noon(2026, 9, 1)]: 1,
      [noon(2026, 9, 2)]: 2,
      [noon(2026, 9, 3)]: 3,
    });
  });

  it('marks every episode of a season whatever each is called, when as many were watched as it has', async () => {
    const lookups: Lookups = {
      searchTv: async () => [{ type: 'tv', id: 7, name: 'Show' }],
      searchMulti: async () => [],
      show: async () => shape({ 1: 3, 2: 2 }, { season: 2, episode: 2 }),
      episodes: async (_id, season) =>
        season === 2
          ? [
              { number: 1, name: 'Uno' },
              { number: 2, name: 'Dos' },
            ]
          : [
              { number: 1, name: 'Primero' },
              { number: 2, name: 'Segundo' },
              { number: 3, name: 'Tercero' },
            ],
    };
    const { marks, unmatched } = await plan(
      [
        { title: 'Show: Season 2: Two', date: '9/2/26' },
        { title: 'Show: Season 2: One', date: '9/1/26' },
        // Two of season 1's three: which two can't be told, so neither is guessed.
        { title: 'Show: Season 1: First', date: '8/1/26' },
        { title: 'Show: Season 1: Second', date: '8/2/26' },
      ],
      lookups,
    );
    expect(marks.map((m) => `S${m.season}E${m.episode}@${m.at}`).sort()).toEqual(
      [`S2E1@${noon(2026, 9, 1)}`, `S2E2@${noon(2026, 9, 2)}`].sort(),
    );
    expect(unmatched.sort()).toEqual(['Show: Season 1: First', 'Show: Season 1: Second']);
  });

  it('splits at the first label, and tries a label that is part of the episode’s own name', async () => {
    expect(parseTitle('Midnight Mass: Limited Series: Book I: Genesis')).toMatchObject({
      show: 'Midnight Mass',
      season: 1,
      episode: 'Book I: Genesis',
    });
    expect(findEpisode('Book I: Genesis', [{ number: 1, name: 'Book I: Genesis' }])).toBe(1);
  });

  it('finds a show TMDB knows by another name or a shorter one, only where its episodes bear it out', async () => {
    const unnamedEpisodes = (count: number) =>
      Array.from({ length: count }, (_, at) => ({ number: at + 1, name: `Episode ${at + 1}` }));
    const lookups: Lookups = {
      searchTv: async (query) =>
        ({
          // TMDB's alternative titles: "The Defeated" is Shadowplay, behind an unrelated first hit.
          'The Defeated': [
            { type: 'tv' as const, id: 1, name: 'The Great Jahy Will Not Be Defeated!' },
            { type: 'tv' as const, id: 2, name: 'Shadowplay' },
          ],
          // Nothing under Netflix's longer name; TMDB's is "Itxaso".
          Itxaso: [{ type: 'tv' as const, id: 3, name: 'Itxaso' }],
          // A long series whose "Episode N" says nothing about which one "Zero" is.
          Zero: [{ type: 'tv' as const, id: 4, name: 'Hawaii Five-0' }],
        })[query] ?? [],
      searchMulti: async () => [],
      show: async (id) => shape(id === 1 ? { 1: 12 } : id === 4 ? { 1: 24 } : { 1: 3 }),
      episodes: async (id) => unnamedEpisodes(id === 1 ? 12 : id === 4 ? 24 : 3),
    };
    const lines = (show: string, episodes: string[]) =>
      episodes.map((episode, at) => ({ title: `${show}: ${episode}`, date: `9/${at + 1}/26` }));
    const { marks, unmatched } = await plan(
      [
        ...lines('The Defeated', ['Homecoming', 'Nakam', 'Mutti']),
        ...lines('Itxaso and the Sea', ['Episode 1', 'Episode 2', 'Episode 3']),
        ...lines('Zero', ['Episode 1', 'Episode 2', 'Episode 3']),
      ],
      lookups,
    );
    expect(marks.map((m) => `${m.id}:${m.episode}`).sort()).toEqual(
      ['2:1', '2:2', '2:3', '3:1', '3:2', '3:3'].sort(),
    );
    expect(unmatched.sort()).toEqual(['Zero: Episode 1', 'Zero: Episode 2', 'Zero: Episode 3']);
  });

  it('reads a film’s name past a leading article, spelt-out numbers, "+" and a thousands comma', () => {
    expect(filmKey('School of Rock')).toBe(filmKey('The School of Rock'));
    expect(filmKey('1,000 Times Good Night')).toBe(filmKey('A Thousand Times Good Night'));
    expect(filmKey('Three Generations')).toBe(filmKey('3 Generations'));
    expect(filmKey('Un plus une')).toBe(filmKey('Un + une'));
  });

  it('splits a line naming two episodes, and reads a season label with a volume or part', () => {
    expect(joined('The Killing: Season 3: From Up Here / The Road to Hamelin')).toEqual([
      'The Killing: Season 3: From Up Here',
      'The Killing: Season 3: The Road to Hamelin',
    ]);
    expect(joined('WHAT / IF: Part I: Pilot')).toEqual(['WHAT / IF: Part I: Pilot']);
    expect(parseTitle('The Chef Show: Season 2 - Volume 1: Tartine')).toMatchObject({
      season: 2,
      episode: 'Tartine',
    });
  });

  it('takes the film of that name out by the year it was watched, deeper than the first page', async () => {
    const lookups: Lookups = {
      searchTv: async () => [],
      searchMulti: async () => [{ type: 'movie', id: 1, name: 'Gone Girl', year: 2014 }],
      searchMovie: async (_q, page) =>
        page === 1
          ? Array.from({ length: 20 }, (_, at) => ({
              type: 'movie' as const,
              id: 100 + at,
              name: at === 0 ? 'Girl' : `Girl ${at}`,
              year: 2024,
            }))
          : [{ type: 'movie', id: 2, name: 'Girl', year: 2018 }],
      show: async () => null,
      episodes: async () => null,
    };
    const { marks } = await plan([{ title: 'Girl', date: '11/2/20' }], lookups);
    expect(marks).toEqual([expect.objectContaining({ type: 'movie', id: 2 })]);
  });

  it('places "Pilot" as the first episode, without it telling two namesakes apart', async () => {
    const lookups: Lookups = {
      searchTv: async () => [
        { type: 'tv', id: 1, name: 'What If...?' },
        { type: 'tv', id: 2, name: 'WHAT / IF' },
      ],
      searchMulti: async () => [],
      show: async () => shape({ 1: 2 }),
      episodes: async (id) =>
        id === 2
          ? [
              { number: 1, name: 'Pilot' },
              { number: 2, name: 'Part II' },
            ]
          : [
              { number: 1, name: 'What If… Captain Carter Were the First Avenger?' },
              { number: 2, name: 'What If… T’Challa Became a Star-Lord?' },
            ],
    };
    const { marks } = await plan([{ title: 'WHAT / IF: Part I: Pilot', date: '9/1/26' }], lookups);
    expect(marks).toEqual([expect.objectContaining({ id: 2, season: 1, episode: 1 })]);
  });

  it('picks the namesake of the year in the name, and a season TMDB gives the show’s name', async () => {
    const lookups: Lookups = {
      searchTv: async (query) =>
        ({
          'Tales of the City': [
            { type: 'tv' as const, id: 1, name: 'Tales of the City', year: 2019 },
            { type: 'tv' as const, id: 2, name: 'Tales of the City', year: 1993 },
          ],
          Entrapped: [{ type: 'tv' as const, id: 3, name: 'Trapped', year: 2015 }],
        })[query] ?? [],
      searchMulti: async () => [],
      show: async (id) =>
        id === 3
          ? { ...shape({ 1: 10, 2: 10, 3: 8 }), seasonNames: new Map([[3, 'Entrapped']]) }
          : shape({ 1: 6 }),
      episodes: async (_id, season) =>
        Array.from({ length: season === 3 ? 8 : 6 }, (_, at) => ({
          number: at + 1,
          name: `Episode ${at + 1}`,
        })),
    };
    const { marks, unmatched } = await plan(
      [
        { title: 'Tales of the City (1993): Episode 1', date: '8/23/19' },
        { title: 'Entrapped: Episode 1', date: '9/28/22' },
        { title: 'Entrapped: Episode 2', date: '9/29/22' },
      ],
      lookups,
    );
    expect(marks.map((m) => `${m.id}:S${m.season}E${m.episode}`).sort()).toEqual(
      ['2:S1E1', '3:S3E1', '3:S3E2'].sort(),
    );
    expect(unmatched).toEqual([]);
  });

  it('marks a two-part TV film whole, and counts a line of a season already covered', async () => {
    const lookups: Lookups = {
      searchTv: async (query) =>
        query === 'Love in Lapland'
          ? [{ type: 'tv', id: 1, name: 'Love in Lapland', year: 2017 }]
          : [{ type: 'tv', id: 2, name: "Grey's Anatomy", year: 2005 }],
      searchMulti: async () => [],
      show: async (id) => shape(id === 1 ? { 1: 2 } : { 6: 2 }),
      episodes: async (id) =>
        id === 1
          ? [
              { number: 1, name: 'Part 1' },
              { number: 2, name: 'Part 2' },
            ]
          : [
              { number: 1, name: 'Good Mourning' },
              { number: 2, name: 'Sanctuary' },
            ],
    };
    const { marks, unmatched, covered } = await plan(
      [
        { title: 'Love in Lapland', date: '11/13/20' },
        { title: "Grey's Anatomy: Season 6: Good Mourning", date: '1/1/20' },
        { title: "Grey's Anatomy: Season 6: Sanctuary", date: '1/2/20' },
        { title: "Grey's Anatomy: Season 6: Goodbye", date: '1/1/20' },
      ],
      lookups,
    );
    expect(marks.map((m) => `${m.id}:S${m.season}E${m.episode}`).sort()).toEqual(
      ['1:S1E1', '1:S1E2', '2:S6E1', '2:S6E2'].sort(),
    );
    expect(unmatched).toEqual([]);
    expect(covered).toBe(1);
  });

  it('finds a name past a bracketed note, and an episode named for its show as the first', async () => {
    expect(findEpisode('Wujing (No. 84)', [{ number: 3, name: 'Wujing' }])).toBe(3);
    const lookups: Lookups = {
      searchTv: async () => [{ type: 'tv', id: 1, name: 'Community' }],
      searchMulti: async () => [],
      show: async () => shape({ 1: 2 }),
      episodes: async () => [
        { number: 1, name: 'Pilot' },
        { number: 2, name: 'Spanish 101' },
      ],
    };
    const { marks } = await plan(
      [{ title: 'Community: Season 1: Community', date: '12/10/20' }],
      lookups,
    );
    expect(marks).toEqual([expect.objectContaining({ id: 1, season: 1, episode: 1 })]);
  });

  it('compares names of symbols as they are, and names past their articles', () => {
    const back = [
      { number: 1, name: '(⊙_⊙)' },
      { number: 2, name: '(¬_¬)' },
    ];
    expect(findEpisode('(¬_¬)', back)).toBe(2);
    expect(findEpisode('(;´∩`;)', back)).toBeUndefined();
    const aloha = [
      { number: 1, name: 'Terrace House in Aloha State' },
      { number: 36, name: 'Bye Bye Terrace House in Aloha State' },
    ];
    expect(findEpisode('Terrace House in the Aloha State', aloha)).toBe(1);
    // "Down This Road" is not "Down the Road": the article goes, the word that tells them apart stays.
    expect(
      findEpisode('Down This Road', [
        { number: 10, name: 'Down the Road' },
        { number: 19, name: 'Down This Road' },
      ]),
    ).toBe(19);
    expect(filmKey('Bordertown: Mural Murders')).toBe(filmKey('Bordertown: The Mural Murders'));
    expect(filmKey('El Pepe, a Supreme Life')).toBe(filmKey('El Pepe: A Supreme Life'));
  });

  it('tries a line its show has no episode for as a film, but never a line with no show', async () => {
    const lookups: Lookups = {
      searchTv: async () => [{ type: 'tv', id: 1, name: 'Bordertown' }],
      searchMulti: async (q) =>
        q.startsWith('Bordertown')
          ? [{ type: 'movie', id: 2, name: 'Bordertown: The Mural Murders', year: 2021 }]
          : [{ type: 'movie', id: 3, name: 'Episode 1', year: 2017 }],
      show: async () => shape({ 1: 3 }),
      episodes: async () => [
        { number: 1, name: 'Dolls' },
        { number: 2, name: 'Lady in the Lake' },
        { number: 3, name: 'The Fury' },
      ],
    };
    const { marks, unmatched } = await plan(
      [
        { title: 'Bordertown: Dolls', date: '1/1/21' },
        { title: 'Bordertown: Mural Murders', date: '12/12/21' },
        { title: ': Episode 1', date: '1/1/21' },
      ],
      lookups,
    );
    expect(marks.map((m) => `${m.type}:${m.id}`).sort()).toEqual(['movie:2', 'tv:1'].sort());
    expect(unmatched).toEqual([': Episode 1']);
  });

  it('reads æ and œ as two letters, and "Volume 1" as "Vol. I" but never a lone "I" as 1', () => {
    expect(filmKey('Innsaei')).toBe(filmKey('InnSæi'));
    expect(filmKey('Demi-Soeur')).toBe(filmKey('Demi-sœur'));
    expect(filmKey('Nymphomaniac: Volume 1')).toBe(filmKey('Nymphomaniac: Vol. I'));
    expect(filmKey('I Am Legend')).not.toBe(filmKey('1 Am Legend'));
  });

  it('takes a film named as Netflix’s without its subtitle or sequel number, only as a last resort', async () => {
    const lookups: Lookups = {
      searchTv: async () => [],
      searchMulti: async (q) =>
        ({
          'JOY - The Birth of IVF': [{ type: 'movie' as const, id: 1, name: 'JOY', year: 2024 }],
          'Through My Window 2: Across the Sea': [
            {
              type: 'movie' as const,
              id: 2,
              name: 'Through My Window: Across the Sea',
              year: 2023,
            },
          ],
        })[q] ?? [],
      show: async () => null,
      episodes: async () => null,
    };
    const { marks, unmatched } = await plan(
      [
        { title: 'JOY - The Birth of IVF', date: '12/8/24' },
        { title: 'Through My Window 2: Across the Sea', date: '2/25/24' },
      ],
      lookups,
    );
    expect(marks.map((m) => m.id).sort()).toEqual([1, 2]);
    expect(unmatched).toEqual([]);
  });

  it('takes a film over a series of the same name', async () => {
    const lookups: Lookups = {
      searchTv: async () => [],
      searchMulti: async () => [
        { type: 'tv', id: 62687, name: 'Limitless' },
        { type: 'movie', id: 51876, name: 'Limitless' },
      ],
      show: async () => null,
      episodes: async () => null,
    };
    const { marks } = await plan([{ title: 'Limitless', date: '9/1/26' }], lookups);
    expect(marks).toEqual([expect.objectContaining({ type: 'movie', id: 51876 })]);
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
    show: async () => shape({ 0: 1, 1: 24, 2: 24, 3: 25, 4: 24 }),
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
      expect.arrayContaining(
        [
          { type: 'tv', id: 1668, season: 4, episode: 12, at: noon(2026, 9, 20) },
          { type: 'tv', id: 1668, season: 4, episode: 1, at: noon(2026, 9, 14) },
          { type: 'tv', id: 1668, season: 3, episode: 25, at: noon(2026, 9, 12) },
          { type: 'movie', id: 1, source: 'Office Romance', at: noon(2026, 9, 12) },
        ].map((mark) => expect.objectContaining(mark)),
      ),
    );
    expect(result.marks).toHaveLength(4);
    expect(result.shows[1668]?.counts.get(4)).toBe(24);
    expect(result.unmatched.sort()).toEqual([
      'Fito Páez: The World Within a Song',
      'Friends: Season 4: The One Nobody Wrote',
    ]);
    expect(result.undated).toBe(1);
  });

  it('looks nothing more up for a series or film the library already has as seen', async () => {
    let seasonLookups = 0;
    const counted: Lookups = {
      ...lookups,
      episodes: (id, season) => (seasonLookups++, lookups.episodes(id, season)),
    };
    const result = await plan(
      [
        { title: 'Friends: Season 4: The One with the Embryos', date: '9/20/26' },
        { title: 'Friends: Season 4: The One with the Jellyfish', date: '9/14/26' },
        { title: 'Office Romance', date: '9/12/26' },
      ],
      counted,
      undefined,
      () => true,
    );
    expect(result.marks).toEqual([]);
    expect(result.known).toBe(3);
    expect(seasonLookups).toBe(0);
  });
});

describe('writing the marks', () => {
  const device = 'feedfacefeedface';
  const none: Rows = { title: () => undefined, episode: () => undefined };
  const now = noon(2026, 9, 28);
  const friends = { type: 'tv' as const, id: 1668, name: 'Friends', source: 'Friends' };
  const ep = (episode: number, at: number): EpisodeRow =>
    markEpisode(
      {
        kind: 'ep',
        schema: 2,
        title: { type: 'tv', id: 1668 },
        season: 4,
        episode,
        progress: { value: 0, at: ZERO_STAMP, viewing: 0 },
      },
      true,
      [at, 0, 'tv'],
    );
  const written = (writes: Writes[]) => writes.flatMap((w) => w.rows);

  it('writes each mark as its own row stamped with the day it was watched, which the TV sends Simkl as the date', () => {
    const at = noon(2026, 9, 20);
    const rows = written(
      importWrites(
        [
          { ...friends, season: 4, episode: 12, at },
          { type: 'movie', id: 1, name: 'Office Romance', source: 'Office Romance', at },
        ],
        {},
        none,
        device,
        now,
      ),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        kind: 'ep',
        season: 4,
        episode: 12,
        progress: expect.objectContaining({ value: 1, at: [at, 0, device] }),
      }),
      expect.objectContaining({
        kind: 'rec',
        status: { value: 'watched', at: [at, 1, device] },
        watchedAt: at,
      }),
    ]);
    // No tracker events: each is an immutable row about three times an episode row's size, which a long history
    // filled a library with. The TV's catch-up sends Simkl the rows themselves.
    expect(rows.some((row) => row.kind === 'set' || trackerEvent(row))).toBe(false);
  });

  it('writes nothing for a mark imported before, whatever its place in the file', () => {
    const at = noon(2026, 9, 20);
    const mark = { ...friends, season: 4, episode: 12, at };
    const imported = written(importWrites([mark], {}, none, device, now))[0] as EpisodeRow;
    // The same file again, this mark now second: a higher counter on the same day.
    const rows: Rows = {
      title: () => undefined,
      episode: (_r, _s, e) => (e === 12 ? imported : undefined),
    };
    expect(
      written(importWrites([{ ...mark, episode: 13 }, mark], {}, rows, device, now)),
    ).toHaveLength(1);
  });

  it('leaves out a mark older than what the library already says, and dates a newer one by Netflix', () => {
    const mark = { ...friends, season: 4, episode: 12, at: noon(2026, 9, 20) };
    const holding = (row: EpisodeRow): Rows => ({ title: () => undefined, episode: () => row });
    expect(
      written(importWrites([mark], {}, holding(ep(12, noon(2026, 9, 25))), device, now)),
    ).toEqual([]);
    const [newer] = written(
      importWrites([mark], {}, holding(ep(12, noon(2025, 1, 1))), device, now),
    );
    expect(newer).toMatchObject({ progress: { at: [mark.at, 0, device] } });
  });

  it('marks a series seen once the import and the library hold every aired episode', () => {
    const show = shape({ 0: 3, 4: 3 }, { season: 4, episode: 2 });
    const marks = [
      { ...friends, season: 4, episode: 1, at: noon(2026, 9, 10) },
      { ...friends, season: 4, episode: 2, at: noon(2026, 9, 12) },
    ];
    const series = written(importWrites(marks, { 1668: show }, none, device, now)).at(-1)!;
    // Episode 3 hasn't aired, and specials don't count.
    expect(series).toMatchObject({
      kind: 'rec',
      status: { value: 'watched', at: [noon(2026, 9, 12), 2, device] },
    });
    // One aired episode only the library holds: still finished.
    const rows: Rows = {
      title: () => undefined,
      episode: (_r, _s, e) => (e === 1 ? ep(1, noon(2020, 1, 1)) : undefined),
    };
    const partly = importWrites([marks[1]!], { 1668: show }, rows, device, now);
    expect(written(partly).at(-1)).toMatchObject({
      kind: 'rec',
      status: { value: 'watched' },
    });
  });

  it('takes an unfinished series last watched over half a year ago off Continue Watching, and a recent one not', () => {
    const show = shape({ 4: 24 });
    const old = importWrites(
      [{ ...friends, season: 4, episode: 1, at: noon(2025, 1, 5) }],
      { 1668: show },
      none,
      device,
      now,
    );
    expect(old[0]!.rows.filter((row) => row.kind === 'rec')).toEqual([
      expect.objectContaining({
        kind: 'rec',
        dismissed: { value: true, at: [noon(2025, 1, 5) + 1, 1, device] },
      }),
    ]);
    const recent = importWrites(
      [{ ...friends, season: 4, episode: 1, at: noon(2026, 9, 5) }],
      { 1668: show },
      none,
      device,
      now,
    );
    expect(recent[0]!.rows.every((row) => row.kind === 'ep')).toBe(true);
  });
});
