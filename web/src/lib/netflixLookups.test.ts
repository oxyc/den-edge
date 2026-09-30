import { describe, expect, it, vi } from 'vitest';
import { netflixLookups } from './netflixLookups';

describe('Netflix import lookups', () => {
  it('waits out den-edge’s per-minute limit together, says so, and loses no answer to it', async () => {
    let refused = false;
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      if (!refused) {
        refused = true;
        return new Response('{}', { status: 429, headers: { 'Retry-After': '1' } });
      }
      return new Response(JSON.stringify({ results: [{ id: 1, name: 'Friends' }] }));
    }) as typeof fetch;
    const pauses: number[] = [];
    const lookups = netflixLookups('den-proxy', fetchImpl, (ms) => pauses.push(ms));
    const started = Date.now();
    const [a, b] = await Promise.all([lookups.searchTv('Friends'), lookups.searchTv('Friends')]);
    expect(a).toEqual([{ type: 'tv', id: 1, name: 'Friends' }]);
    expect(b).toEqual(a);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    // Refused once, then both asked again after the pause; the pause announced, then its end.
    expect(asked).toHaveLength(3);
    expect(pauses[0]).toBeGreaterThan(0);
    // The retry and the timer that clears the waiting notice become runnable together. Either may resume first,
    // so wait for the notice callback rather than making their event-loop order part of the contract.
    await vi.waitFor(() => expect(pauses.at(-1)).toBe(0));
  });
});
