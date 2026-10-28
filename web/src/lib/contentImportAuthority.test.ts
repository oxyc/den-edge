import { describe, expect, it, vi } from 'vitest';
import { ContentImportAuthority } from './contentImportAuthority';

describe('ContentImportAuthority', () => {
  it('waits out one shared provider limit without losing concurrent answers', async () => {
    let refused = false;
    const asked: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      if (!refused) {
        refused = true;
        return new Response('{}', { status: 429, headers: { 'Retry-After': '1' } });
      }
      return Response.json({ results: [{ id: 1, name: 'Friends' }] });
    }) as typeof fetch;
    // The pause and the back-off are the authority's own timers: they run on a fake clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const authority = new ContentImportAuthority(() => 'private-key', fetchImpl);
      const pending = authority.resolve(
        [
          { id: 'a', kind: 'search', media: 'tv', query: 'Friends' },
          { id: 'b', kind: 'search', media: 'tv', query: 'Friends' },
        ],
        new AbortController().signal,
      );
      // The refused lookup asks again only after its first back-off (2 s), which outlasts the 1 s it was told.
      await vi.advanceTimersByTimeAsync(1_999);
      expect(asked, 'nothing is asked again before the wait is over').toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      const results = await pending;

      expect(results.map(({ value }) => value)).toEqual([
        { kind: 'search', hits: [{ type: 'tv', id: 1, name: 'Friends' }] },
        { kind: 'search', hits: [{ type: 'tv', id: 1, name: 'Friends' }] },
      ]);
    } finally {
      vi.useRealTimers();
    }
    expect(asked).toHaveLength(3);
    expect(asked.every((url) => url.includes('api_key=private-key'))).toBe(true);
  });

  it('normalizes runtimes and reuses one translations document', async () => {
    let translations = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/movie/7')) return Response.json({ runtime: 123 });
      if (path.endsWith('/tv/8')) return Response.json({ episode_run_time: [null, 47] });
      if (path.endsWith('/movie/7/translations')) {
        translations++;
        return Response.json({
          translations: [
            { data: { title: 'La película', overview: 'La historia localizada.' } },
            { data: { title: 'The Film', overview: 'The localized story.' } },
          ],
        });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const authority = new ContentImportAuthority(() => 'private-key', fetchImpl);
    const signal = new AbortController().signal;

    await expect(
      authority.resolve(
        [
          { id: 'movie', kind: 'runtime', title: { type: 'movie', id: 7 } },
          { id: 'series', kind: 'runtime', title: { type: 'tv', id: 8 } },
          {
            id: 'titles',
            kind: 'translations',
            title: { type: 'movie', id: 7 },
            field: 'title',
          },
        ],
        signal,
      ),
    ).resolves.toMatchObject([
      { value: { kind: 'runtime', minutes: 123 } },
      { value: { kind: 'runtime', minutes: 47 } },
      { value: { kind: 'translations', values: ['La película', 'The Film'] } },
    ]);
    await expect(
      authority.resolve(
        [
          {
            id: 'overviews',
            kind: 'translations',
            title: { type: 'movie', id: 7 },
            field: 'overview',
          },
        ],
        signal,
      ),
    ).resolves.toMatchObject([
      {
        value: {
          kind: 'translations',
          values: ['La historia localizada.', 'The localized story.'],
        },
      },
    ]);
    expect(translations).toBe(1);
  });
});
