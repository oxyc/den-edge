import { describe, expect, it, vi } from 'vitest';
import {
  ContentAuthority,
  WorkerContentCredentials,
  type ContentCredentialSource,
} from './contentAuthority';
import { titleBrief } from './tmdb';
import { cachingFetch, type Brief, type Entry, type Store } from './tmdbCache';

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
  it('omits English language and isolates Spanish and Swedish TMDB URLs', async () => {
    const asked: string[] = [];
    const tmdbFetch = vi.fn<typeof fetch>(async (input) => {
      asked.push(String(input));
      return json({ id: 603, title: 'The Matrix', original_title: 'The Matrix' });
    });
    const authority = new ContentAuthority(credentials(), { tmdbFetch });

    await authority.title({ type: 'movie', id: 603 }, 'en');
    await authority.title({ type: 'movie', id: 603 }, 'es');
    await authority.title({ type: 'movie', id: 603 }, 'sv');

    const urls = asked.map((value) => new URL(value));
    expect(urls.map((url) => url.searchParams.get('language'))).toEqual([null, 'es-ES', 'sv-SE']);
    expect(new Set(asked).size).toBe(3);
  });

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

  it('names a title kept before briefs from its answer once, then from its brief alone', async () => {
    const answers = new Map<string, Entry>();
    const briefs = new Map<string, Brief>();
    const reads = { answers: 0 };
    const store: Store = {
      get: async (key) => (reads.answers++, answers.get(key)),
      put: async (key, entry) => void answers.set(key, entry),
      prune: async () => 0,
      clear: async () => answers.clear(),
      briefs: {
        get: async (key) => briefs.get(key),
        put: async (key, brief) => void briefs.set(key, brief),
        prune: async () => 0,
        clear: async () => briefs.clear(),
      },
    };
    answers.set('https://api.themoviedb.org/3/movie/603?append_to_response=credits', {
      body: JSON.stringify({ id: 603, title: 'The Matrix', poster_path: '/m.jpg', credits: {} }),
      fetchedAt: 0,
      checked: true,
    });
    const network = vi.fn<typeof fetch>();
    const tmdbFetch = cachingFetch(store, network, () => 1_000, titleBrief);
    const ref = { type: 'movie', id: 603 } as const;

    const first = await new ContentAuthority(credentials(), { tmdbFetch }).title(ref);
    expect(first).toMatchObject({ kind: 'found', value: { title: { title: 'The Matrix' } } });
    expect(reads.answers, 'no brief yet: the kept answer names it').toBe(1);
    await vi.waitFor(() => expect(briefs.size).toBe(1));

    reads.answers = 0;
    const again = await new ContentAuthority(credentials(), { tmdbFetch }).title(ref);
    expect(again).toEqual(first);
    expect(reads.answers, 'named from its brief').toBe(0);
    expect(network).not.toHaveBeenCalled();
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

  it('keeps equal Atlas selections on independent cursors and cancels only one page', async () => {
    const credentials = new WorkerContentCredentials();
    credentials.configureAtlas('/atlas');
    const asked: string[] = [];
    const pending: Array<{
      signal: AbortSignal | null;
      answer: (response: Response) => void;
    }> = [];
    const authority = new ContentAuthority(credentials, {
      providerFetch: (input, init) => {
        const url = String(input);
        if (url === '/metadata/title/query') return Promise.resolve(json({ entries: [] }));
        if (init?.signal?.aborted) return Promise.reject(init.signal.reason);
        asked.push(url);
        const skip = Number(new URL(url, 'https://example.test').searchParams.get('skip') ?? 0);
        if (!skip)
          return Promise.resolve(
            json({
              order: 'stable',
              titles: [{ type: 'movie', id: asked.length, title: `Page ${asked.length}` }],
            }),
          );
        return new Promise<Response>((resolve, reject) => {
          const signal = init?.signal ?? null;
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          pending.push({ signal, answer: resolve });
        });
      },
    });
    const firstCursor = crypto.randomUUID();
    const secondCursor = crypto.randomUUID();
    const query = (
      cursor: string,
      page: number,
      items: Array<{ kind: string; id: string }> = [],
    ) => ({
      kind: 'atlas.query' as const,
      query: {
        operation: 'titles' as const,
        cursor,
        type: 'movie' as const,
        items,
        page,
      },
    });

    await authority.query(query(firstCursor, 1), new AbortController().signal);
    await authority.query(query(secondCursor, 1), new AbortController().signal);

    const first = new AbortController();
    const second = new AbortController();
    const cancelled = authority.query(query(firstCursor, 2), first.signal);
    const surviving = authority.query(query(secondCursor, 2), second.signal);
    await expect.poll(() => pending.length).toBe(2);
    expect(pending.map(({ signal }) => signal)).toEqual([first.signal, second.signal]);
    first.abort();
    pending[1]!.answer(
      json({ order: 'stable', titles: [{ type: 'movie', id: 25, title: 'Page two' }] }),
    );

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await expect(surviving).resolves.toMatchObject({
      kind: 'atlas.query',
      answer: { state: 'ready', value: { operation: 'titles', titles: [{ id: 25 }] } },
    });
    // Aborting retired only that cursor, so its opaque id can begin a different selection.
    await expect(
      authority.query(query(firstCursor, 1, [{ kind: 'genre', id: '18' }]), first.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      authority.query(
        query(firstCursor, 1, [{ kind: 'genre', id: '18' }]),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ answer: { state: 'ready' } });
    expect(asked).toEqual([
      '/atlas/index/filter/movie/titles.json',
      '/atlas/index/filter/movie/titles.json',
      '/atlas/index/filter/movie/titles.json?skip=24',
      '/atlas/index/filter/movie/titles.json?skip=24',
      '/atlas/index/filter/movie/titles.json?sel=genre:18',
    ]);
  });

  it('rejects a cursor whose selection mutates, then retires it on completion and reconfiguration', async () => {
    const credentials = new WorkerContentCredentials();
    credentials.configureAtlas('/atlas');
    const authority = new ContentAuthority(credentials, {
      providerFetch: async (input) => {
        const url = String(input);
        if (url === '/metadata/title/query') return json({ entries: [] });
        return json({
          order: 'stable',
          titles: url.includes('genre:18') ? [{ type: 'movie', id: 1, title: 'One' }] : [],
        });
      },
    });
    const query = (cursor: string, genre: string) => ({
      kind: 'atlas.query' as const,
      query: {
        operation: 'titles' as const,
        cursor,
        type: 'movie' as const,
        items: [{ kind: 'genre', id: genre }],
        page: 1,
      },
    });

    // An empty page retires the cursor, so the same opaque id no longer retains a completed selection.
    const completed = crypto.randomUUID();
    await expect(
      authority.query(query(completed, '35'), new AbortController().signal),
    ).resolves.toMatchObject({ answer: { state: 'ready' } });
    await expect(
      authority.query(query(completed, '18'), new AbortController().signal),
    ).resolves.toMatchObject({ answer: { state: 'ready' } });

    const active = crypto.randomUUID();
    await authority.query(query(active, '18'), new AbortController().signal);
    await expect(
      authority.query(query(active, '35'), new AbortController().signal),
    ).rejects.toMatchObject({ failure: { code: 'invalid-request', provider: 'atlas' } });

    await authority.query(
      { kind: 'sources.configure', atlas: '/atlas-next' },
      new AbortController().signal,
    );
    await expect(
      authority.query(query(active, '35'), new AbortController().signal),
    ).resolves.toMatchObject({ answer: { state: 'ready' } });
  });

  it('bounds Atlas cursor state with least-recently-used retirement', async () => {
    const credentials = new WorkerContentCredentials();
    credentials.configureAtlas('/atlas');
    const authority = new ContentAuthority(credentials, {
      providerFetch: async (input) =>
        String(input) === '/metadata/title/query'
          ? json({ entries: [] })
          : json({
              order: 'stable',
              titles: [{ type: 'movie', id: 1, title: 'One' }],
            }),
    });
    const cursors = Array.from({ length: 65 }, () => crypto.randomUUID());
    const request = (cursor: string, genre: string) => ({
      kind: 'atlas.query' as const,
      query: {
        operation: 'titles' as const,
        cursor,
        type: 'movie' as const,
        items: [{ kind: 'genre', id: genre }],
        page: 1,
      },
    });
    for (const cursor of cursors)
      await authority.query(request(cursor, '18'), new AbortController().signal);

    // The oldest was evicted and may start over; the newest still owns its immutable selection.
    await expect(
      authority.query(request(cursors[0]!, '35'), new AbortController().signal),
    ).resolves.toMatchObject({ answer: { state: 'ready' } });
    await expect(
      authority.query(request(cursors.at(-1)!, '35'), new AbortController().signal),
    ).rejects.toMatchObject({ failure: { code: 'invalid-request', provider: 'atlas' } });
  });

  it('keeps an Atlas row or chart only once den-edge answered its poster fill', async () => {
    const credentials = new WorkerContentCredentials();
    // `reuse` is shared by the module: a fresh base keeps this test's questions its own.
    const atlas = `/atlas-fill-${crypto.randomUUID()}`;
    credentials.configureAtlas(atlas);
    const asked: string[] = [];
    let metadata = 0;
    const authority = new ContentAuthority(credentials, {
      providerFetch: async (input) => {
        const url = String(input);
        if (url === '/metadata/title/query')
          return ++metadata === 1
            ? json({}, { status: 429, headers: { 'retry-after': '1' } })
            : json({
                entries: [
                  {
                    type: 'movie',
                    id: 7,
                    source: 'tmdb',
                    fields: { posterPath: { value: '/seven.jpg', observedAt: Date.now() - 1 } },
                  },
                ],
              });
        asked.push(url.includes('/catalog/') ? 'chart' : 'row');
        return url.includes('/catalog/')
          ? json({ metas: [{ type: 'movie', moviedb_id: 7, name: 'Seven' }] })
          : json({ titles: [{ type: 'movie', id: 7, title: 'Seven' }] });
      },
    });
    const signal = new AbortController().signal;
    const posters = async (request: Parameters<ContentAuthority['query']>[0]) => {
      const answer = await authority.query(request, signal);
      const titles = 'titles' in answer && 'state' in answer.titles ? answer.titles : undefined;
      return titles?.state === 'ready' ? titles.value.map((title) => title.posterPath) : null;
    };

    for (const request of [
      { kind: 'atlas.row', type: 'movie', where: { mood: 'Tense' }, page: 1 },
      { kind: 'atlas.service.chart', catalog: { id: 'nfx-new', type: 'movie' }, country: 'FI' },
    ] as const) {
      metadata = 0;
      asked.length = 0;
      // Refused: the titles are still handed over, without their poster.
      expect(await posters(request)).toEqual([undefined]);
      // Not kept: the next ask fills it.
      expect(await posters(request)).toEqual(['/seven.jpg']);
      // Kept: answered from the first complete answer.
      expect(await posters(request)).toEqual(['/seven.jpg']);
      expect(metadata).toBe(2);
      expect(asked).toHaveLength(2);
    }
  });

  it('reads a 404 from an Atlas shared by a grant as unavailable, never as nothing there', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const answers = async (atlas: string) => {
      const credentials = new WorkerContentCredentials();
      credentials.configureAtlas(atlas);
      const authority = new ContentAuthority(credentials, {
        tmdbFetch: async () => json({ imdb_id: null }),
        providerFetch: async () => json({ error: 'not_found' }, { status: 404 }),
      });
      const signal = new AbortController().signal;
      const home = await authority.query(
        { kind: 'atlas.recommend.shared', scope: 'home', day: '2026-10-17', fresh: false },
        signal,
      );
      const row = await authority.query(
        { kind: 'atlas.row', type: 'movie', where: { genre: 'drama' }, page: 1 },
        signal,
      );
      const extras = await authority.query(
        { kind: 'title.extras', title: { type: 'movie', id: 42 }, warningCategories: [] },
        signal,
      );
      return [
        home.kind === 'atlas.recommend.shared' && home.slides.state,
        row.kind === 'atlas.row' && row.titles.state,
        extras.kind === 'title.extras' && extras.extras.facts.state,
      ];
    };

    // den-edge's own Atlas: a 404 is a path with nothing at it.
    expect(await answers(`/atlas-own-${crypto.randomUUID()}`)).toEqual([
      'absent',
      'absent',
      'absent',
    ]);
    expect(warn).not.toHaveBeenCalled();
    // A guest's shared one: the same 404 is what den-edge answers a refused grant with.
    expect(await answers('/atlas/~a1b2c3d4')).toEqual([
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('a1b2c3d4');
    warn.mockRestore();
  });

  it('lets shared recommendation waiters cancel independently over one GET', async () => {
    const credentials = new WorkerContentCredentials();
    credentials.configureAtlas(`/atlas-shared-${crypto.randomUUID()}`);
    let answer!: (response: Response) => void;
    const providerFetch = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((resolve) => {
          expect(init?.signal).toBeUndefined();
          answer = resolve;
        }),
    );
    const authority = new ContentAuthority(credentials, { providerFetch });
    const request = {
      kind: 'atlas.recommend.shared' as const,
      scope: 'home' as const,
      day: '2026-10-09',
      fresh: false,
    };
    const first = new AbortController();
    const second = new AbortController();
    const cancelled = authority.query(request, first.signal);
    const surviving = authority.query(request, second.signal);
    await expect.poll(() => providerFetch).toHaveBeenCalledTimes(1);
    first.abort();
    answer(json({ slides: [] }));

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await expect(surviving).resolves.toMatchObject({
      kind: 'atlas.recommend.shared',
      slides: { state: 'ready', value: [] },
    });
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps personalized recommendation POSTs and cancellation request-owned', async () => {
    const credentials = new WorkerContentCredentials();
    credentials.configureAtlas('/atlas');
    const pending: Array<{
      signal: AbortSignal | null | undefined;
      answer: (response: Response) => void;
    }> = [];
    const authority = new ContentAuthority(credentials, {
      providerFetch: (_input, init) =>
        new Promise<Response>((resolve, reject) => {
          pending.push({ signal: init?.signal, answer: resolve });
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    });
    const request = {
      kind: 'atlas.recommend.personal' as const,
      body: {
        version: 1 as const,
        surface: 'home' as const,
        now: '2026-10-09T00:00:00.000Z',
        services: [],
        library: [],
        owned: [],
        hide: { minYear: 1900, genres: [], languages: [], anime: false },
      },
    };
    const first = new AbortController();
    const second = new AbortController();
    const cancelled = authority.query(request, first.signal);
    const surviving = authority.query(request, second.signal);

    await expect.poll(() => pending.length).toBe(2);
    expect(pending.map(({ signal }) => signal)).toEqual([first.signal, second.signal]);
    first.abort();
    pending[1]!.answer(json({ slides: [] }));

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await expect(surviving).resolves.toMatchObject({
      kind: 'atlas.recommend.personal',
      slides: { state: 'ready', value: [] },
    });
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

  it('projects a hero and a full detail from one provider read without shrinking the cached detail', async () => {
    let answer!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => (answer = resolve));
    const tmdbFetch = vi.fn(() => pending);
    const authority = new ContentAuthority(credentials({ tmdb: 'key' }), { tmdbFetch });
    const signal = new AbortController().signal;

    const hero = authority.query(
      { kind: 'title.hero', title: { type: 'movie', id: 550 }, region: 'US' },
      signal,
    );
    const full = authority.query(
      { kind: 'title.detail', title: { type: 'movie', id: 550 }, region: 'us' },
      signal,
    );
    await expect.poll(() => tmdbFetch.mock.calls.length).toBe(1);

    answer(
      json({
        id: 550,
        title: 'Fight Club',
        release_date: '1999-10-15',
        overview: 'An insomniac meets a soap maker.',
        backdrop_path: '/fight.jpg',
        runtime: 139,
        genres: [
          { id: 18, name: 'Drama' },
          { id: 53, name: 'Thriller' },
          { id: 35, name: 'Comedy' },
        ],
        credits: { cast: [{ id: 1, name: 'Edward Norton' }], crew: [] },
        recommendations: { results: [] },
        videos: { results: [] },
        external_ids: { imdb_id: 'tt0137523' },
        release_dates: { results: [] },
        'watch/providers': { results: {} },
      }),
    );

    await expect(hero).resolves.toEqual({
      kind: 'title.hero',
      hero: {
        state: 'ready',
        value: {
          overview: 'An insomniac meets a soap maker.',
          backdropPath: '/fight.jpg',
          runtime: 139,
          genres: [
            { id: 18, name: 'Drama' },
            { id: 53, name: 'Thriller' },
          ],
          imdbId: 'tt0137523',
        },
      },
    });
    await expect(full).resolves.toMatchObject({
      kind: 'title.detail',
      detail: {
        state: 'ready',
        value: {
          title: { id: 550, title: 'Fight Club' },
          genres: [
            { id: 18, name: 'Drama' },
            { id: 53, name: 'Thriller' },
            { id: 35, name: 'Comedy' },
          ],
          cast: [{ id: 1, name: 'Edward Norton' }],
        },
      },
    });
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
