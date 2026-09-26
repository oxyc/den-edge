import { describe, expect, it, vi } from 'vitest';
import { fetchIconicStudios, parseIconicStudios } from './iconicStudios';

describe('iconic studios', () => {
  it('keeps valid, named QIDs once and in Atlas order', () => {
    expect(
      parseIconicStudios({
        studios: [
          { id: 'Q159846', name: 'A24' },
          { id: 'Q159846', name: 'A24 duplicate' },
          { id: '159', name: 'No Q' },
          { id: 'Q2', name: '  ' },
          null,
        ],
      }),
    ).toEqual([{ id: 'Q159846', name: 'A24' }]);
    expect(parseIconicStudios({ studios: 'not a list' })).toEqual([]);
  });

  it('asks the title endpoint with Atlas media names', async () => {
    const network = vi.fn(
      async () => new Response(JSON.stringify({ studios: [{ id: 'Q159846', name: 'A24' }] })),
    ) as unknown as typeof fetch;
    await expect(
      fetchIconicStudios('/atlas/', { type: 'tv', id: 42 }, undefined, network),
    ).resolves.toEqual([{ id: 'Q159846', name: 'A24' }]);
    expect(network).toHaveBeenCalledWith('/atlas/index/studios/series/42.json', {
      signal: undefined,
    });
  });

  it('degrades to no curated links when Atlas is absent, old or unavailable', async () => {
    const missing = vi.fn(
      async () => new Response('{}', { status: 404 }),
    ) as unknown as typeof fetch;
    expect(await fetchIconicStudios(null, { type: 'movie', id: 1 }, undefined, missing)).toEqual(
      [],
    );
    expect(missing).not.toHaveBeenCalled();
    expect(
      await fetchIconicStudios('/atlas', { type: 'movie', id: 1 }, undefined, missing),
    ).toEqual([]);
    const down = vi.fn(async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    expect(await fetchIconicStudios('/atlas', { type: 'movie', id: 1 }, undefined, down)).toEqual(
      [],
    );
  });
});
