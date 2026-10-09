import { describe, expect, it, vi } from 'vitest';
import {
  ContentAuthority,
  WorkerContentCredentials,
  type ContentCredentialSource,
} from './contentAuthority';

const credentials = (
  values: {
    tmdb?: string;
    omdb?: string;
    warnings?: string;
  } = {},
): ContentCredentialSource => ({
  tmdb: () => values.tmdb,
  omdb: () => values.omdb,
  contentWarnings: () => values.warnings,
});

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });

describe('ContentAuthority', () => {
  it('validates candidate and saved provider keys without returning either key', async () => {
    const seen: Array<{ url: string; key: string | null }> = [];
    const answer = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const key = new Headers(init?.headers).get('x-api-key');
      seen.push({ url, key });
      return new Response('{}', { status: url.includes('refused') || key === 'bad' ? 401 : 200 });
    };
    const authority = new ContentAuthority(
      credentials({ tmdb: 'saved-tmdb', omdb: 'saved-omdb', warnings: 'saved-warnings' }),
      { tmdbFetch: answer, providerFetch: answer },
    );
    const signal = new AbortController().signal;

    await expect(
      authority.query({ kind: 'provider-key.check', service: 'tmdb' }, signal),
    ).resolves.toEqual({
      kind: 'provider-key.check',
      service: 'tmdb',
      outcome: 'accepted',
    });
    await expect(
      authority.query({ kind: 'provider-key.check', service: 'omdb', candidate: 'bad' }, signal),
    ).resolves.toEqual({
      kind: 'provider-key.check',
      service: 'omdb',
      outcome: 'refused',
    });
    await expect(
      authority.query({ kind: 'provider-key.check', service: 'content-warnings' }, signal),
    ).resolves.toMatchObject({ outcome: 'accepted' });
    expect(seen).toEqual([
      { url: expect.stringContaining('api_key=saved-tmdb'), key: null },
      { url: '/ratings/check', key: 'bad' },
      { url: '/warnings/check', key: 'saved-warnings' },
    ]);
  });

  it('keeps a useful service-directory half when the other provider request is unavailable', async () => {
    const tmdbFetch = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/watch/providers/tv')) return json({}, { status: 503 });
      return json({
        results: [{ provider_id: 8, provider_name: 'Netflix', display_priority: 1 }],
      });
    });
    const authority = new ContentAuthority(credentials(), { tmdbFetch });

    await expect(
      authority.query({ kind: 'service.directory', region: 'FI' }, new AbortController().signal),
    ).resolves.toMatchObject({
      kind: 'service.directory',
      complete: false,
      services: [{ id: 8, movies: true, series: false }],
    });
  });

  it('configures one discovered Atlas source for later Worker-owned queries', async () => {
    const credentials = new WorkerContentCredentials();
    const asked: string[] = [];
    const authority = new ContentAuthority(credentials, {
      tmdbFetch: async () => json({ imdb_id: null }),
      providerFetch: async (input) => {
        asked.push(String(input));
        return json({ error: 'not_found' }, { status: 404 });
      },
    });
    const signal = new AbortController().signal;

    await authority.query({ kind: 'sources.configure', atlas: 'http://atlas.test/base' }, signal);
    await authority.query(
      { kind: 'title.extras', title: { type: 'movie', id: 42 }, warningCategories: [] },
      signal,
    );

    expect(asked).toEqual([
      'http://atlas.test/base/index/title/movie/42.json',
      'http://atlas.test/base/index/studios/movie/42.json',
    ]);
  });

  it('coalesces an exact detail request and returns normalized detail without exposing its key', async () => {
    let answer!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => (answer = resolve));
    const tmdbFetch = vi.fn(() => pending);
    const authority = new ContentAuthority(credentials({ tmdb: 'private-tmdb-key' }), {
      tmdbFetch,
    });

    const first = authority.detail({ type: 'movie', id: 550 }, 'us');
    const second = authority.detail({ type: 'movie', id: 550 }, 'US');
    expect(tmdbFetch).toHaveBeenCalledTimes(1);

    answer(
      json({
        id: 550,
        title: 'Fight Club',
        release_date: '1999-10-15',
        genres: [{ id: 18, name: 'Drama' }],
        credits: { cast: [], crew: [] },
        recommendations: { results: [] },
        videos: { results: [] },
        external_ids: { imdb_id: 'tt0137523' },
        release_dates: { results: [] },
        'watch/providers': { results: {} },
      }),
    );

    const [left, right] = await Promise.all([first, second]);
    expect(left).toEqual(right);
    expect(left).toMatchObject({
      kind: 'found',
      value: {
        title: { id: 550, title: 'Fight Club', year: 1999 },
        genres: [{ id: 18, name: 'Drama' }],
        imdbId: 'tt0137523',
      },
    });
    expect(JSON.stringify(left)).not.toContain('private-tmdb-key');
  });

  it('distinguishes a confirmed TMDB miss from a retryable provider refusal', async () => {
    const tmdbFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: 'not_found' }, { status: 404 }))
      .mockResolvedValueOnce(
        json({ error: 'rate_limited' }, { status: 503, headers: { 'retry-after': '7' } }),
      );
    const authority = new ContentAuthority(credentials(), {
      tmdbFetch,
      now: () => 1_000,
    });

    await expect(authority.identifiers({ type: 'movie', id: 1 })).resolves.toEqual({
      kind: 'missing',
    });
    await expect(authority.identifiers({ type: 'movie', id: 2 })).resolves.toEqual({
      kind: 'unavailable',
      reason: 'rate-limited',
      status: 503,
      retryAfterMs: 7_000,
    });
    expect(tmdbFetch.mock.calls[0]?.[0]).toContain('api_key=den-proxy');
  });

  it('loads ratings and warnings independently with private provider credentials', async () => {
    const seen = new Map<string, Headers>();
    const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      seen.set(path, new Headers(init?.headers));
      if (path.startsWith('/ratings/'))
        return json({
          Response: 'True',
          imdbRating: '8.8',
          imdbVotes: '2,345',
          Ratings: [{ Source: 'Rotten Tomatoes', Value: '91%' }],
        });
      return json({
        id: 42,
        warnings: [
          {
            id: 7,
            name: 'flashing lights',
            category: 'Lights',
            yes: 5,
            no: 1,
            spoiler: false,
          },
          {
            id: 8,
            name: 'filtered category',
            category: 'Other',
            yes: 9,
            no: 0,
            spoiler: false,
          },
        ],
      });
    });
    const authority = new ContentAuthority(
      credentials({ omdb: 'private-omdb', warnings: 'private-warnings' }),
      { providerFetch },
    );

    const extras = await authority.extras('tt0137523', ['Lights']);
    expect(extras).toEqual({
      ratings: {
        kind: 'found',
        value: { imdb: 8.8, votes: 2345, rottenTomatoes: 91 },
      },
      warnings: {
        kind: 'found',
        value: {
          id: 42,
          warnings: [{ id: 7, label: 'flashing lights', votes: 5 }],
        },
      },
    });
    expect(seen.get('/ratings/imdb/tt0137523')?.get('x-api-key')).toBe('private-omdb');
    expect(seen.get('/warnings/imdb/tt0137523')?.get('x-api-key')).toBe('private-warnings');
    expect(JSON.stringify(extras)).not.toContain('private-');
  });

  it('normalizes seasons and external identifiers while preserving a known empty identifier', async () => {
    const tmdbFetch = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/season/2'))
        return json({
          episodes: [
            { episode_number: 1, name: 'One', still_path: '/one.jpg' },
            { episode_number: 1, name: 'duplicate' },
            { episode_number: 2, name: 'Two', runtime: 54 },
          ],
        });
      return json({ imdb_id: null });
    });
    const authority = new ContentAuthority(credentials(), { tmdbFetch });

    await expect(authority.season(10, 2)).resolves.toMatchObject({
      kind: 'found',
      value: [
        { number: 1, name: 'One', stillPath: '/one.jpg' },
        { number: 2, name: 'Two', runtime: 54 },
      ],
    });
    await expect(authority.identifiers({ type: 'tv', id: 10 })).resolves.toEqual({
      kind: 'found',
      value: { imdbId: null },
    });
  });
});
