import { describe, expect, it } from 'vitest';
import { keepingAtlasFetch, RETENTION, type KeptAtlasAnswer } from './atlasKept';
import { onKeptAnswers } from './keptAnswers';
import type { Kept } from './tmdbCache';

function memoryStore(): Kept<KeptAtlasAnswer> & { entries: Map<string, KeptAtlasAnswer> } {
  const entries = new Map<string, KeptAtlasAnswer>();
  return {
    entries,
    get: async (key) => entries.get(key),
    put: async (key, value) => void entries.set(key, value),
    prune: async () => 0,
    clear: async () => entries.clear(),
  };
}

const ROW = '/atlas/index/row/movie.json?mood=Dark&skip=0&limit=24';
const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
  });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('keepingAtlasFetch', () => {
  it('hands out the last answer while atlas cannot be reached, and says so', async () => {
    const store = memoryStore();
    let now = 1_000;
    let answer: () => Promise<Response> = async () =>
      json({ titles: [{ id: 1 }] }, { 'x-den-policy': 'p1' });
    const fetchImpl = keepingAtlasFetch(
      () => answer(),
      store,
      () => now,
    );
    const heard: boolean[] = [];
    const stop = onKeptAnswers((provider, kept) => provider === 'atlas' && heard.push(kept));

    expect(await (await fetchImpl(ROW)).json()).toEqual({ titles: [{ id: 1 }] });
    await settle();
    expect(store.entries.get(ROW)).toMatchObject({ policy: 'p1', fetchedAt: 1_000 });

    // Cloudflare with no copy of its own, the origin down.
    now = 5_000;
    answer = async () => new Response('<html>522</html>', { status: 522 });
    const kept = await fetchImpl(ROW);
    expect(kept.status).toBe(200);
    expect(kept.headers.get('x-den-kept')).toBe('1000');
    expect(kept.headers.get('x-den-policy')).toBe('p1');
    expect(await kept.json()).toEqual({ titles: [{ id: 1 }] });

    // No connection at all.
    answer = () => Promise.reject(new TypeError('Failed to fetch'));
    expect((await fetchImpl(ROW)).headers.get('x-den-kept')).toBe('1000');

    // Back: the live answer, and the page told once.
    answer = async () => json({ titles: [{ id: 2 }] });
    expect(await (await fetchImpl(ROW)).json()).toEqual({ titles: [{ id: 2 }] });
    expect(heard).toEqual([true, false]);
    stop();
  });

  it('passes a failure on when nothing usable is kept', async () => {
    const store = memoryStore();
    let now = 0;
    let answer: () => Promise<Response> = async () => json({ titles: [] });
    const fetchImpl = keepingAtlasFetch(
      () => answer(),
      store,
      () => now,
    );
    await fetchImpl(ROW);
    await settle();

    answer = async () => new Response('', { status: 502 });
    now = RETENTION;
    expect((await fetchImpl(ROW)).status).toBe(502);
    // A different question is never answered with another's copy.
    expect((await fetchImpl(`${ROW}&skip=24`)).status).toBe(502);
    answer = () => Promise.reject(new TypeError('Failed to fetch'));
    await expect(fetchImpl('/atlas/index/row/series.json')).rejects.toThrow('Failed to fetch');
  });

  it('keeps only the first page of what a screen opens on, and never a refusal', async () => {
    const store = memoryStore();
    const fetchImpl = keepingAtlasFetch(async (input) => {
      const url = String(input);
      return url.includes('missing') ? json({ error: 'not_found' }) : json({ ok: true });
    }, store);
    await fetchImpl('/atlas/index/search.json?q=al');
    await fetchImpl('/atlas/index/row/movie.json?mood=Dark&skip=24&limit=24');
    await fetchImpl('/atlas/index/row/movie.json?mood=Dark&skip=0&limit=24');
    await fetchImpl('/atlas/index/filter/movie/titles.json?sel=primary:Action');
    await fetchImpl('/atlas/recommend', { method: 'POST', body: '{}' });
    await fetchImpl('/atlas/index/title/movie/603.json');
    await fetchImpl('/atlas/recommend/home.json?day=2026-11-07');
    await fetchImpl('/atlas/catalog/movie/den-nfx/country=FI.json');
    await fetchImpl('/atlas/manifest.json');
    const refused = keepingAtlasFetch(async () => new Response('{}', { status: 404 }), store);
    await refused('/atlas/index/row/movie.json?missing=1');
    await settle();
    expect([...store.entries.keys()].sort()).toEqual([
      '/atlas/catalog/movie/den-nfx/country=FI.json',
      '/atlas/index/row/movie.json?mood=Dark&skip=0&limit=24',
      '/atlas/index/title/movie/603.json',
      '/atlas/manifest.json',
      '/atlas/recommend/home.json?day=2026-11-07',
    ]);
  });
});
