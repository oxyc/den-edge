import { describe, expect, it } from 'vitest';
import { labelsFor, neighbourhood } from './atlasIndex';

const answering = (reply: (route: string, body: Record<string, unknown>) => unknown) => {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push({ url, body });
    return { ok: true, json: async () => reply(url, body) } as Response;
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
};

describe('labelsFor', () => {
  it('asks for series by the name atlas uses, since Den’s own would score a silent zero', async () => {
    const { sent, fetchImpl } = answering(() => ({
      labels: [{ subgenres: [['Neo-Noir', 0.9]], moods: [] }, null],
    }));
    const found = await labelsFor(
      '/atlas',
      [
        { type: 'tv', id: 1399 },
        { type: 'movie', id: 155 },
      ],
      fetchImpl,
    );
    expect(sent[0]?.body.titles).toEqual([
      { type: 'series', id: 1399 },
      { type: 'movie', id: 155 },
    ]);
    // Positional, and a null is a title atlas has never indexed rather than one with nothing in common.
    expect(found.get('tv:1399')?.subgenres).toEqual([['Neo-Noir', 0.9]]);
    expect(found.has('movie:155')).toBe(false);
  });

  it('splits a pool into requests atlas will accept, and asks about a title once', async () => {
    const { sent, fetchImpl } = answering((_url, body) => ({
      labels: (body.titles as unknown[]).map(() => ({ subgenres: [], moods: [] })),
    }));
    const refs = Array.from({ length: 900 }, (_, i) => ({ type: 'movie' as const, id: i }));
    const found = await labelsFor('/atlas', [...refs, ...refs.slice(0, 50)], fetchImpl);
    expect(sent.map((s) => (s.body.titles as unknown[]).length)).toEqual([500, 400]);
    expect(found.size).toBe(900);
  });

  it('says nothing rather than failing when atlas cannot be reached', async () => {
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(labelsFor('/atlas', [{ type: 'movie', id: 1 }], failing)).resolves.toEqual(
      new Map(),
    );
  });
});

describe('neighbourhood', () => {
  it('counts how many of the library’s seeds each title is a neighbour of', async () => {
    const { sent, fetchImpl } = answering(() => ({
      perSeed: [
        { seed: { type: 'movie', id: 155 }, ids: [1, 2] },
        { seed: { type: 'movie', id: 603 }, ids: [2, 3] },
      ],
    }));
    const { seeds, hits } = await neighbourhood(
      '/atlas',
      [
        { type: 'movie', id: 155 },
        { type: 'movie', id: 603 },
      ],
      fetchImpl,
    );
    expect(sent[0]?.body.seeds).toHaveLength(2);
    expect(seeds).toBe(2);
    // Deep inside the neighbourhood: two different seeds both lead here.
    expect(hits.get('movie:2')).toBe(2);
    expect(hits.get('movie:1')).toBe(1);
    expect(hits.has('movie:9')).toBe(false);
  });

  it('reads a series seed’s answers back into Den’s own media type', async () => {
    const { fetchImpl } = answering(() => ({
      perSeed: [{ seed: { type: 'series', id: 1396 }, ids: [95396] }],
    }));
    const { hits } = await neighbourhood('/atlas', [{ type: 'tv', id: 1396 }], fetchImpl);
    expect(hits.get('tv:95396')).toBe(1);
  });

  it('counts only the seeds atlas could answer for, since it holds few series', async () => {
    const { fetchImpl } = answering(() => ({
      perSeed: [
        { seed: { type: 'movie', id: 155 }, ids: [1] },
        { seed: { type: 'series', id: 1396 }, ids: [] },
      ],
    }));
    const { seeds, hits } = await neighbourhood(
      '/atlas',
      [
        { type: 'movie', id: 155 },
        { type: 'tv', id: 1396 },
      ],
      fetchImpl,
    );
    // One of the two said nothing, so a title every answering seed leads to is wholly redundant, not half.
    expect(seeds).toBe(1);
    expect(hits.get('movie:1')).toBe(1);
  });

  it('asks for nothing when there are no seeds', async () => {
    const { sent, fetchImpl } = answering(() => ({ perSeed: [] }));
    expect(await neighbourhood('/atlas', [], fetchImpl)).toEqual({ seeds: 0, hits: new Map() });
    expect(sent).toHaveLength(0);
  });
});
