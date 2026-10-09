import { describe, expect, it } from 'vitest';
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
    const authority = new ContentImportAuthority(() => 'private-key', fetchImpl);
    const started = Date.now();
    const results = await authority.resolve(
      [
        { id: 'a', kind: 'search', media: 'tv', query: 'Friends' },
        { id: 'b', kind: 'search', media: 'tv', query: 'Friends' },
      ],
      new AbortController().signal,
    );

    expect(results.map(({ value }) => value)).toEqual([
      { kind: 'search', hits: [{ type: 'tv', id: 1, name: 'Friends' }] },
      { kind: 'search', hits: [{ type: 'tv', id: 1, name: 'Friends' }] },
    ]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
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
