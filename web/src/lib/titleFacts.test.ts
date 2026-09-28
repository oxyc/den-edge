import { describe, expect, it } from 'vitest';
import { chipFor, fetchTitleFacts, NO_FACTS, parseTitleFacts } from './titleFacts';

const facts = parseTitleFacts({
  networks: [{ id: 'Q23589', name: 'Showtime', titles: 59 }],
  companies: [
    { id: 'Q16248298', name: 'A24', titles: 40 },
    { id: 'nope', name: 'Bad id' },
    { id: 'Q5', name: '  ' },
  ],
  subjects: [{ id: 'Q362', name: 'World War II', titles: 577 }],
});

describe('parseTitleFacts', () => {
  it('keeps well-formed values and drops the rest', () => {
    expect(facts.networks).toEqual([{ id: 'Q23589', name: 'Showtime', titles: 59 }]);
    expect(facts.companies).toEqual([{ id: 'Q16248298', name: 'A24', titles: 40 }]);
    expect(facts.subjects[0]?.name).toBe('World War II');
    expect(facts.places).toEqual([]);
    expect(parseTitleFacts(null)).toEqual(NO_FACTS);
  });
});

describe('chipFor', () => {
  it('links TMDB’s name to atlas’s value by name, networks before companies', () => {
    expect(chipFor('Showtime', facts)).toBe('network-Q23589');
    expect(chipFor('a24', facts)).toBe('company-Q16248298');
    expect(chipFor('HBO', facts)).toBeUndefined();
  });
});

describe('fetchTitleFacts', () => {
  it('asks atlas for the title, and answers nothing without an atlas or an answer', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ networks: [{ id: 'Q1', name: 'N', titles: 3 }] }));
    }) as unknown as typeof fetch;
    const got = await fetchTitleFacts('/atlas/', { type: 'tv', id: 1398 }, undefined, fetchImpl);
    expect(asked).toEqual(['/atlas/index/title/series/1398.json']);
    expect(got.networks).toEqual([{ id: 'Q1', name: 'N', titles: 3 }]);
    expect(await fetchTitleFacts(null, { type: 'tv', id: 1 })).toEqual(NO_FACTS);
    const down = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    const failed = await fetchTitleFacts('/atlas', { type: 'movie', id: 1 }, undefined, down);
    expect(failed).toEqual(NO_FACTS);
  });
});
