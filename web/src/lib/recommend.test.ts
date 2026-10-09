import { describe, expect, it } from 'vitest';
import type { Title } from './library';
import type { Prefs } from './prefs';
import {
  billboardScope,
  displayableKept,
  enrichPersonalBackdrop,
  freshOn,
  keepPersonalBackdrop,
  memberPostOn,
  nameSlides,
  personalHeroCopy,
  recommend,
  recommendationReason,
  recommendBody,
  recommendForEveryone,
  preloadPersonalBackdrop,
  replacePersonalBillboard,
  startBillboard,
  type KeptBillboard,
} from './recommend';

const film = (id: number, extra: Partial<Title> = {}): Title => ({
  type: 'movie',
  id,
  title: `T${id}`,
  ...extra,
});

describe('recommendForEveryone', () => {
  it('asks for the scope’s billboard for the UTC day with GET', async () => {
    const asked: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      asked.push({ url, init });
      return new Response(JSON.stringify({ slides: [{ type: 'series', id: 1438 }] }));
    }) as unknown as typeof fetch;
    const slides = await recommendForEveryone(
      '/atlas',
      billboardScope('tv'),
      false,
      new Date('2026-09-28T23:30:00-03:00'),
      fetchImpl,
    );
    expect(slides).toEqual([{ type: 'tv', id: 1438, imdbId: undefined, why: undefined }]);
    expect(asked[0]!.url).toBe('/atlas/recommend/series.json?day=2026-09-29');
    expect(asked[0]!.init?.method ?? 'GET').toBe('GET');
    expect(billboardScope(null)).toBe('home');
  });

  it('returns nothing where atlas cannot rank', async () => {
    const unavailable = (async () =>
      new Response('{}', { status: 404 })) as unknown as typeof fetch;
    const malformed = (async () => new Response('{}')) as unknown as typeof fetch;
    expect(await recommendForEveryone('/atlas', 'home', false, new Date(), unavailable)).toBeNull();
    expect(await recommendForEveryone('/atlas', 'home', false, new Date(), malformed)).toBeNull();
  });

  it('asks for only new titles with fresh, as an address of its own', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ slides: [] }));
    }) as unknown as typeof fetch;
    const now = new Date('2026-09-28T12:00:00Z');
    startBillboard('/', false, true, now, fetchImpl);
    expect(asked).toEqual(['/atlas/recommend/home.json?day=2026-09-28&fresh=1']);
    // The started answer is only-new-titles, so a page without fresh asks for its own.
    await recommendForEveryone('/atlas', 'home', false, now, fetchImpl);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toBe('/atlas/recommend/home.json?day=2026-09-28');
    await recommendForEveryone('/atlas', 'home', true, now, fetchImpl);
    expect(asked).toHaveLength(2);
  });

  it('takes the billboard the app started asking for once', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ slides: [{ type: 'movie', id: asked.length }] }));
    }) as unknown as typeof fetch;
    const now = new Date('2026-09-28T12:00:00Z');
    startBillboard('/movies', false, false, now, fetchImpl);
    startBillboard('/watchlist', false, false, now, fetchImpl);
    expect(asked).toEqual(['/atlas/recommend/movies.json?day=2026-09-28']);
    expect((await recommendForEveryone('/atlas', 'movies', false, now, fetchImpl))?.[0]?.id).toBe(
      1,
    );
    expect(asked).toHaveLength(1);
    await recommendForEveryone('/atlas', 'movies', false, now, fetchImpl);
    expect(asked).toHaveLength(2);
  });

  it('starts nothing for a paired browser, whose Home asks its own atlas install', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ slides: [{ type: 'movie', id: 1 }] }));
    }) as unknown as typeof fetch;
    const now = new Date('2026-09-28T12:00:00Z');
    startBillboard('/', true, false, now, fetchImpl);
    expect(asked).toEqual([]);
    await recommendForEveryone('/atlas/us_8', 'home', false, now, fetchImpl);
    expect(asked).toEqual(['/atlas/us_8/recommend/home.json?day=2026-09-28']);
  });
});

describe('memberPostOn', () => {
  const storage = () => {
    const kept = new Map<string, string>();
    return {
      getItem: (name: string) => kept.get(name) ?? null,
      setItem: (name: string, value: string) => void kept.set(name, value),
    };
  };

  it('keeps the fresh switch apart from the member switch, set the same way', () => {
    const kept = storage();
    expect(freshOn('', kept)).toBe(true);
    expect(freshOn('?billboard-fresh=0', kept)).toBe(false);
    expect(kept.getItem('den.billboard.fresh')).toBe('0');
    expect(memberPostOn('', kept)).toBe(true);
    expect(freshOn('', kept)).toBe(false);
    expect(freshOn('?billboard-fresh=1', kept)).toBe(true);
    expect(freshOn('', kept)).toBe(true);
  });

  it('is on until this browser turns it off, and the parameter is remembered', () => {
    const kept = storage();
    expect(memberPostOn('', kept)).toBe(true);
    expect(memberPostOn('?billboard-post=0', kept)).toBe(false);
    expect(memberPostOn('', kept)).toBe(false);
    expect(memberPostOn('?billboard-post=1', kept)).toBe(true);
    expect(memberPostOn('', kept)).toBe(true);
  });

  it('reads the flag set by hand, and the parameter where storage refuses', () => {
    const kept = storage();
    kept.setItem('den.billboard.member-post', '0');
    expect(memberPostOn('', kept)).toBe(false);
    const refusing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(memberPostOn('?billboard-post=0', refusing)).toBe(false);
    expect(memberPostOn('', refusing)).toBe(true);
  });
});

describe('recommend', () => {
  const prefs = {
    excludedGenres: new Set([27]),
    excludedLanguages: new Set(['ja']),
    hideAnime: true,
    minReleaseYear: 1990,
    services: [{ id: 8, country: 'US' }],
    servicesConfigured: true,
  } as unknown as Prefs;

  it('sends the whole library with what TMDB said of it, and nothing to rank it against', () => {
    const body = recommendBody({
      facet: 'tv',
      prefs,
      library: [
        { ref: { type: 'tv', id: 1438 }, weight: 1, at: 5 },
        { ref: { type: 'movie', id: 2 }, weight: -1.5, at: 9 },
      ],
      named: new Map([
        ['movie:2', film(2, { year: 2020, rating: 7, ratingSource: 'tmdb', votes: 10 })],
      ]),
      owned: new Set(['tv:1438', 'movie:2', 'bogus']),
      now: new Date('2026-09-30T12:00:00Z'),
    });
    expect(body).toEqual({
      version: 1,
      surface: 'series',
      now: '2026-09-30T12:00:00.000Z',
      services: [{ id: 8, country: 'US' }],
      library: [
        {
          type: 'movie',
          id: 2,
          weight: -1.5,
          at: 9,
          hint: expect.objectContaining({ title: 'T2', year: 2020, rating: 7, votes: 10 }),
        },
        { type: 'series', id: 1438, weight: 1, at: 5 },
      ],
      owned: [
        { type: 'series', id: 1438 },
        { type: 'movie', id: 2 },
      ],
      hide: { minYear: 1990, genres: [27], languages: ['ja'], anime: true },
    });
    expect(body).not.toHaveProperty('candidates');
    expect(body).not.toHaveProperty('fresh');
  });

  it('names the surface of the page it ranks for: Home, Movies or Series', () => {
    const surface = (facet: 'movie' | 'tv' | null) =>
      recommendBody({ facet, prefs, library: [], owned: new Set() }).surface;
    expect([surface(null), surface('movie'), surface('tv')]).toEqual(['home', 'movies', 'series']);
    expect([billboardScope(null), billboardScope('movie'), billboardScope('tv')]).toEqual([
      'home',
      'movies',
      'series',
    ]);
  });

  it('asks for only new titles with fresh', () => {
    const body = recommendBody({ facet: null, prefs, library: [], owned: new Set(), fresh: true });
    expect(body).toMatchObject({ surface: 'home', fresh: true });
  });

  it('sends only the last 180 days of the library for taste, all of what it owns, and the whole library when nothing is that recent', () => {
    const now = new Date('2026-09-30T12:00:00Z');
    const day = 86_400_000;
    const library = [
      { ref: { type: 'movie' as const, id: 1 }, weight: 1, at: now.getTime() - 10 * day },
      { ref: { type: 'movie' as const, id: 2 }, weight: 2, at: now.getTime() - 400 * day },
    ];
    const owned = new Set(['movie:1', 'movie:2']);
    const body = recommendBody({ facet: null, prefs, library, owned, now });
    expect(body.library.map((entry) => entry.id)).toEqual([1]);
    expect(body.owned.map((entry) => entry.id)).toEqual([1, 2]);
    const old = recommendBody({ facet: null, prefs, library: library.slice(1), owned, now });
    expect(old.library.map((entry) => entry.id)).toEqual([2]);
  });

  it('keeps a library past atlas’s limit to its most recent titles', () => {
    const library = Array.from({ length: 5001 }, (_, i) => ({
      ref: { type: 'movie' as const, id: i },
      weight: 1,
      at: i,
    }));
    const body = recommendBody({ facet: null, prefs, library, owned: new Set() });
    expect(body.library).toHaveLength(5000);
    expect(body.library.some((entry) => entry.id === 0)).toBe(false);
  });

  it('POSTs the body and reads atlas’s slides; null where atlas can’t rank', async () => {
    const asked: { url: string; init?: RequestInit }[] = [];
    const answering = (async (url: string, init?: RequestInit) => {
      asked.push({ url, init });
      return new Response(
        JSON.stringify({ slides: [{ type: 'series', id: 7, why: { reason: 'profile' } }] }),
      );
    }) as unknown as typeof fetch;
    const body = recommendBody({ facet: null, prefs, library: [], owned: new Set() });
    expect(await recommend('/atlas/us_8', body, answering)).toEqual([
      { type: 'tv', id: 7, imdbId: undefined, why: { reason: 'profile' } },
    ]);
    expect(asked[0]!.url).toBe('/atlas/us_8/recommend');
    expect(asked[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(asked[0]!.init?.body))).toEqual(body);

    const failing = (async () => new Response('{}', { status: 400 })) as unknown as typeof fetch;
    const unreachable = (async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    expect(await recommend('/atlas', body, failing)).toBeNull();
    expect(await recommend('/atlas', body, unreachable)).toBeNull();
  });
});

describe('displayableKept', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const titles = [film(1)];

  it('is fresh for a day, stale-displayable for a week, and then expires', () => {
    expect(displayableKept({ at: now - 60_000, titles }, now)).toEqual({ titles, fresh: true });
    expect(displayableKept({ at: now - 86_400_000 + 1, titles }, now)).toEqual({
      titles,
      fresh: true,
    });
    expect(displayableKept({ at: now - 86_400_000, titles }, now)).toEqual({
      titles,
      fresh: false,
    });
    expect(displayableKept({ at: now - 2 * 86_400_000, titles }, now)).toEqual({
      titles,
      fresh: false,
    });
    expect(displayableKept({ at: now - 7 * 86_400_000 + 1, titles }, now)).toEqual({
      titles,
      fresh: false,
    });
    expect(displayableKept({ at: now - 7 * 86_400_000, titles }, now)).toBeNull();
    expect(displayableKept({ at: now + 60_000, titles }, now)).toBeNull();
    expect(displayableKept({ at: now, titles: [] }, now)).toBeNull();
    expect(displayableKept(undefined, now)).toBeNull();
    // A bare list, as the shared billboard is kept, has no age to judge.
    expect(displayableKept(titles as unknown as KeptBillboard, now)).toBeNull();
  });
});

describe('personal backdrop preload', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  const memory = () => {
    const values = new Map<string, string>();
    return {
      values,
      storage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    };
  };
  const preloads = () => {
    const made: string[] = [];
    return { made, start: (url: string) => made.push(url) };
  };

  it('warms only the exact fresh mode, facet and library named by the synchronous pointer', async () => {
    const { values, storage } = memory();
    await keepPersonalBackdrop('library-secret', null, true, '/personal-lead.jpg', now, storage);
    expect([...values.keys()].join()).not.toContain('library-secret');
    expect([...values.entries()]).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.stringMatching(/^den\.hero-lead\.v1\.[0-9a-f]{64}\.fresh\.all$/),
          JSON.stringify({ at: now, path: '/personal-lead.jpg' }),
        ]),
        expect.arrayContaining([
          'den.hero-lead.current.v1.fresh.all',
          expect.stringContaining('"identity":"library-secret"'),
        ]),
      ]),
    );

    for (const [page, identity, fresh, enabled] of [
      ['/', 'another-library', true, true],
      ['/', 'library-secret', false, true],
      ['/movies', 'library-secret', true, true],
      ['/', 'library-secret', true, false],
      ['/watchlist', 'library-secret', true, true],
    ] as const) {
      const preload = preloads();
      expect(
        await preloadPersonalBackdrop(page, identity, fresh, enabled, now, storage, preload.start),
      ).toBeNull();
      expect(preload.made).toEqual([]);
    }

    const preload = preloads();
    expect(
      await preloadPersonalBackdrop('/', 'library-secret', true, true, now, storage, preload.start),
    ).toBe('https://image.tmdb.org/t/p/w1280/personal-lead.jpg');
    expect(preload.made).toEqual(['https://image.tmdb.org/t/p/w1280/personal-lead.jpg']);
  });

  it('shares the seven-day display boundary and removes invalid or expired paths', async () => {
    const { values, storage } = memory();
    await keepPersonalBackdrop('library', 'movie', false, '/lead.jpg', now, storage);
    const staleTitles = [film(7, { backdropPath: '/lead.jpg' })];
    expect(displayableKept({ at: now, titles: staleTitles }, now + 2 * 86_400_000)).toEqual({
      titles: staleTitles,
      fresh: false,
    });
    const dayTwo = preloads();
    expect(
      await preloadPersonalBackdrop(
        '/movies',
        'library',
        false,
        true,
        now + 2 * 86_400_000,
        storage,
        dayTwo.start,
      ),
    ).toContain('/lead.jpg');
    expect(dayTwo.made).toEqual(['https://image.tmdb.org/t/p/w1280/lead.jpg']);

    const preload = preloads();
    expect(
      await preloadPersonalBackdrop(
        '/movies',
        'library',
        false,
        true,
        now + 7 * 86_400_000 - 1,
        storage,
        preload.start,
      ),
    ).toContain('/lead.jpg');
    expect(
      await preloadPersonalBackdrop(
        '/movies',
        'library',
        false,
        true,
        now + 7 * 86_400_000,
        storage,
        preload.start,
      ),
    ).toBeNull();
    expect(values.size).toBe(0);

    await keepPersonalBackdrop(
      'library',
      'movie',
      false,
      'https://wrong.example/art',
      now,
      storage,
    );
    expect(values.size).toBe(0);
  });

  it('clears the old hint before replacing its encrypted ranking', async () => {
    const { values, storage } = memory();
    await keepPersonalBackdrop('library', null, true, '/old.jpg', now, storage);
    let oldPresentWhenSaveStarted = true;
    await expect(
      replacePersonalBillboard(
        'library',
        null,
        true,
        [film(2, { backdropPath: '/new.jpg' })],
        async () => {
          oldPresentWhenSaveStarted = values.size > 0;
          throw new Error('encrypted keep failed');
        },
        now + 1,
        storage,
      ),
    ).rejects.toThrow('encrypted keep failed');
    expect(oldPresentWhenSaveStarted).toBe(false);
    expect(values.size).toBe(0);

    await replacePersonalBillboard(
      'library',
      null,
      true,
      [film(2, { backdropPath: '/new.jpg' })],
      async (kept) => expect(kept.titles[0]?.id).toBe(2),
      now + 2,
      storage,
    );
    expect(
      [...values]
        .filter(([key]) => key.startsWith('den.hero-lead.v1.'))
        .map(([, value]) => JSON.parse(value)),
    ).toEqual([
      {
        at: now + 2,
        path: '/new.jpg',
        copy: { type: 'movie', id: 2, title: 'T2' },
      },
    ]);
  });

  it('keeps bounded lead copy and enriches it without extending its lifetime', async () => {
    const { values, storage } = memory();
    const lead = film(42, {
      title: '  A   short title  ',
      year: 2026,
      backdropPath: '/lead.jpg',
    });
    const basic = personalHeroCopy({ ...lead, why: { reason: 'profile' } });
    await keepPersonalBackdrop('library', null, true, '/lead.jpg', now, storage, basic);
    await enrichPersonalBackdrop(
      'library',
      null,
      true,
      { ...lead, why: { reason: 'profile' } },
      {
        overview: '  The   retained overview.  ',
        runtime: 98,
        genres: [{ name: 'Drama' }, { name: 'Mystery' }, { name: 'Ignored' }],
      },
      now + 86_400_000,
      storage,
    );
    expect(
      [...values]
        .filter(([key]) => key.startsWith('den.hero-lead.v1.'))
        .map(([, value]) => JSON.parse(value)),
    ).toEqual([
      {
        at: now,
        path: '/lead.jpg',
        copy: {
          type: 'movie',
          id: 42,
          title: 'A short title',
          year: 2026,
          reason: 'Fits your viewing taste',
          genres: ['Drama', 'Mystery'],
          overview: 'The retained overview.',
          runtime: 98,
        },
      },
    ]);

    await enrichPersonalBackdrop(
      'library',
      null,
      true,
      { ...lead, backdropPath: '/another.jpg' },
      { overview: 'Must not replace the selected lead.' },
      now + 2 * 86_400_000,
      storage,
    );
    expect(JSON.parse([...values.values()][0]!).copy.overview).toBe('The retained overview.');
  });

  it('retains rich same-lead copy when detail arrives before, during, or after replacement', async () => {
    const lead = film(42, { title: 'Silo', year: 2023, backdropPath: '/silo.jpg' });
    const detail = {
      overview: 'In a ruined and toxic future, a community exists in a giant underground silo.',
      runtime: 50,
      genres: [{ name: 'Drama' }, { name: 'Sci-Fi & Fantasy' }],
    };
    const expected = personalHeroCopy(lead, detail);

    for (const order of ['before-existing', 'before-absent', 'during', 'after'] as const) {
      const { values, storage } = memory();
      const identity = `library-${order}`;
      const enrich = () =>
        enrichPersonalBackdrop(identity, null, true, lead, detail, now + 1, storage);
      let releaseSave = () => {};
      let saveStarted = Promise.resolve();
      let enterSave = () => {};
      if (order === 'during') {
        saveStarted = new Promise<void>((resolve) => (enterSave = resolve));
      }
      const replacement = () =>
        replacePersonalBillboard(
          identity,
          null,
          true,
          [lead],
          async () => {
            if (order !== 'during') return;
            enterSave();
            await new Promise<void>((resolve) => (releaseSave = resolve));
          },
          now,
          storage,
        );

      if (order === 'before-existing') {
        await keepPersonalBackdrop(
          identity,
          null,
          true,
          lead.backdropPath,
          now - 1,
          storage,
          personalHeroCopy(lead),
        );
        await enrich();
        await replacement();
      } else if (order === 'before-absent') {
        await enrich();
        await replacement();
      } else if (order === 'during') {
        const replacing = replacement();
        await saveStarted;
        const enriching = enrich();
        releaseSave();
        await Promise.all([replacing, enriching]);
      } else {
        await replacement();
        await enrich();
      }

      expect(JSON.parse([...values.values()][0]!).copy).toEqual(expected);
    }

    const { values, storage } = memory();
    await keepPersonalBackdrop(
      'library-changed-lead',
      null,
      true,
      lead.backdropPath,
      now - 1,
      storage,
      expected,
    );
    await replacePersonalBillboard(
      'library-changed-lead',
      null,
      true,
      [{ ...film(43), backdropPath: lead.backdropPath }],
      async () => {},
      now,
      storage,
    );
    expect(JSON.parse([...values.values()][0]!).copy).toEqual({
      type: 'movie',
      id: 43,
      title: 'T43',
    });

    const other = film(44, { title: 'Another lead', backdropPath: lead.backdropPath });
    await enrichPersonalBackdrop(
      'library-changed-lead',
      null,
      true,
      other,
      detail,
      now + 1,
      storage,
    );
    expect(JSON.parse([...values.values()][0]!).copy).toEqual({
      type: 'movie',
      id: 43,
      title: 'T43',
    });
  });

  it('rejects invalid copy and caps every retained text field', () => {
    expect(personalHeroCopy(film(1, { title: ' '.repeat(10) }))).toBeUndefined();
    const copy = personalHeroCopy(
      { ...film(1, { title: 'T'.repeat(200), year: 5000 }), why: { reason: 'unknown' } },
      {
        overview: 'O'.repeat(2000),
        runtime: 5000,
        genres: [{ name: 'G'.repeat(100) }, { name: 'Drama' }, { name: 'Mystery' }],
      },
    );
    expect(copy).toEqual({
      type: 'movie',
      id: 1,
      title: 'T'.repeat(160),
      genres: ['G'.repeat(60), 'Drama'],
      overview: 'O'.repeat(1024),
    });
  });

  it('serializes overlapping replacements so the newest encrypted ranking and hint both win', async () => {
    const { storage } = memory();
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => (enteredFirst = resolve));
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    let encrypted: KeptBillboard | undefined;

    const first = replacePersonalBillboard(
      'library',
      null,
      true,
      [film(1, { backdropPath: '/old.jpg' })],
      async (kept) => {
        enteredFirst();
        await firstGate;
        encrypted = kept;
      },
      now,
      storage,
    );
    await firstEntered;
    const second = replacePersonalBillboard(
      'library',
      null,
      true,
      [film(2, { backdropPath: '/new.jpg' })],
      async (kept) => {
        encrypted = kept;
      },
      now + 1,
      storage,
    );
    releaseFirst();
    await Promise.all([first, second]);

    expect(encrypted?.titles[0]?.id).toBe(2);
    const preload = preloads();
    await preloadPersonalBackdrop('/', 'library', true, true, now + 1, storage, preload.start);
    expect(preload.made).toEqual(['https://image.tmdb.org/t/p/w1280/new.jpg']);
  });
});

describe('recommendationReason', () => {
  it.each([
    ['similar', 'Similar to what you watch'],
    ['profile', 'Fits your viewing taste'],
    ['people', 'Cast and creators you like'],
    ['franchise', 'From a franchise you like'],
    ['arrived', 'New on streaming'],
    ['recent', 'Recently released'],
    ['upcoming', 'Coming soon'],
    ['timely', 'New or coming soon'],
    ['quality', 'Highly rated'],
    ['buzz', 'Popular now'],
  ])('renders Atlas reason %s', (reason, copy) => {
    expect(recommendationReason({ reason })).toBe(copy);
  });

  it('stays silent for missing and unknown reason codes', () => {
    expect(recommendationReason(undefined)).toBeUndefined();
    expect(recommendationReason({ fit: 0.7 })).toBeUndefined();
    expect(recommendationReason({ reason: 'future-signal' })).toBeUndefined();
  });
});

describe('nameSlides', () => {
  it('keeps atlas order, names known titles, and drops what TMDB cannot name', async () => {
    const looked: string[] = [];
    const titles = await nameSlides(
      [
        { type: 'movie', id: 2, imdbId: 'tt2' },
        { type: 'tv', id: 1 },
        { type: 'movie', id: 9 },
        { type: 'movie', id: 1 },
      ],
      new Map([['movie:1', film(1)]]),
      async (ref) => {
        looked.push(`${ref.type}:${ref.id}`);
        return ref.id === 9 ? null : { ...film(ref.id), type: ref.type };
      },
      2,
    );
    expect(titles.map((t) => `${t.type}:${t.id}`)).toEqual(['movie:2', 'tv:1', 'movie:1']);
    expect(titles[0]!.imdbId).toBe('tt2');
    expect(looked.sort()).toEqual(['movie:2', 'movie:9', 'tv:1']);
  });

  it('carries why through naming', async () => {
    const why = { score: 0.8, fit: 0.7, reason: 'similar' };
    const titles = await nameSlides(
      [{ type: 'movie', id: 1, why }],
      new Map([['movie:1', film(1)]]),
      async () => null,
      1,
    );
    expect(titles).toEqual([{ ...film(1), imdbId: undefined, why }]);
  });
});
