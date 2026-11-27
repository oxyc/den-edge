import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  openResults,
  resultAddress,
  sealResult,
  strongest,
  watchResults,
  type PlayResult,
} from './playResults';
import { fromHex } from './wire';

// den-spec, checked out at the repository root; the TVs and den-mcp open the same results.
const vectors = JSON.parse(
  readFileSync(new URL('../../../spec/vectors/play-results-v1.json', import.meta.url), 'utf8'),
) as {
  id: string;
  address: string;
  results: { nonce: string; plaintext: string; sealed: string }[];
};

describe('play results v1 match den-spec', () => {
  it("derives the request's address", async () => {
    expect(await resultAddress(vectors.id)).toBe(vectors.address);
  });

  it.each(vectors.results)('seals $plaintext', async ({ nonce, plaintext, sealed }) => {
    const result = JSON.parse(plaintext) as PlayResult;
    expect(await sealResult(vectors.id, result, fromHex(nonce))).toEqual({
      address: vectors.address,
      sealed,
    });
  });

  it('opens them, and nothing sealed for another request', async () => {
    const sealed = vectors.results.map((r) => r.sealed);
    expect(await openResults(vectors.id, sealed)).toEqual([
      { state: 'preparing', at: 1789000061000 },
      { state: 'playing', at: 1789000069000 },
      { state: 'failed', reason: 'no_source', at: 1789000066000 },
    ]);
    expect(await openResults('ffeeddccbbaa99887766554433221101', sealed)).toEqual([]);
    expect(await openResults(vectors.id, ['AAAA', 'not base64!'])).toEqual([]);
  });
});

describe('the strongest result', () => {
  it('ranks playing over failed over preparing, whatever the order they came in', () => {
    const preparing = { state: 'preparing', at: 3 } as const;
    const failed = { state: 'failed', reason: 'no_source', at: 2 } as const;
    const playing = { state: 'playing', at: 1 } as const;
    expect(strongest([playing, failed, preparing])).toBe(playing);
    expect(strongest([failed, preparing])).toBe(failed);
    expect(strongest([preparing])).toBe(preparing);
    expect(strongest([])).toBeNull();
    // Of one rank, the latest.
    const later = { state: 'failed', reason: 'failed', at: 5 } as const;
    expect(strongest([later, failed])).toBe(later);
  });
});

describe('watching a request', () => {
  it('follows a held read to playing and stops', async () => {
    const sealed = vectors.results.map((r) => r.sealed);
    const asked: string[] = [];
    // den-edge answers a hold once it has more than `after`: preparing first, then all three.
    const answers = [[sealed[0]], sealed];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      return Response.json({ results: answers[asked.length - 1] ?? sealed });
    }) as typeof fetch;
    const seen: PlayResult[] = [];
    await watchResults(vectors.id, (r) => seen.push(r), new AbortController().signal, fetchImpl);
    expect(seen.map((r) => r.state)).toEqual(['preparing', 'playing']);
    expect(asked).toEqual([
      `/play/result/${vectors.address}?after=0&wait=25`,
      `/play/result/${vectors.address}?after=1&wait=25`,
    ]);
  });
});
