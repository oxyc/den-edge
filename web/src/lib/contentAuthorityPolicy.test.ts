import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentAuthority, WorkerContentCredentials } from './contentAuthority';
import type { ContentPolicy, ContentRequest } from './contentServiceProtocol';
import { forgetReused } from './reuse';

const KID: ContentPolicy = {
  maximumAge: 12,
  unknownRatings: 'block',
  kidAudience: 'child-or-teen',
};
const KID_QUERY = 'maximumAge=12&unknownRatings=block&kidAudience=child-or-teen';
const LITTLE: ContentPolicy = { maximumAge: 7, unknownRatings: 'block', kidAudience: 'child' };
const CEILING: ContentPolicy = { maximumAge: 13, unknownRatings: 'allow' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Public minimum ages by `type:id`; a title absent from the map is one the store has never heard of. */
const AGES: Record<string, number | null> = {
  'movie:1': 7,
  'movie:2': 12,
  'movie:3': 15,
  'movie:4': null,
  'tv:5': 10,
};

interface World {
  atlas: string[];
  tmdb: string[];
  authority: ContentAuthority;
  ask: (request: ContentRequest, policy?: ContentPolicy) => Promise<unknown>;
}

/** An atlas that answers `/index/title` from AGES and every other route with `routes`, and a TMDB that records. */
function world(
  routes: (url: string, init?: RequestInit) => Response | undefined = () => undefined,
  options: { atlas?: boolean; atlasDown?: boolean } = {},
): World {
  const credentials = new WorkerContentCredentials();
  if (options.atlas !== false) credentials.configureAtlas('/atlas');
  const seen: World = { atlas: [], tmdb: [] } as unknown as World;
  const authority = new ContentAuthority(credentials, {
    providerFetch: async (input, init) => {
      const url = String(input);
      if (url.startsWith('/metadata/')) return json({ entries: [] });
      seen.atlas.push(init?.body ? `${url} ${String(init.body)}` : url);
      if (options.atlasDown) return json({ error: 'down' }, 503);
      const title = /^\/atlas\/index\/title\/(movie|series)\/(\d+)\.json/.exec(url);
      if (title) {
        const key = `${title[1] === 'series' ? 'tv' : 'movie'}:${title[2]}`;
        return key in AGES
          ? json({ type: title[1], id: Number(title[2]), indexed: true, minimumAge: AGES[key] })
          : json({ error: 'not_found' }, 404);
      }
      return routes(url, init) ?? json({ error: 'not_found' }, 404);
    },
    tmdbFetch: async (input) => {
      const url = String(input);
      seen.tmdb.push(url);
      const id = /\/(movie|tv)\/(\d+)/.exec(url);
      return json({
        id: Number(id?.[2] ?? 0),
        title: `Title ${id?.[2]}`,
        name: `Title ${id?.[2]}`,
        release_date: '2020-01-01',
        credits: { cast: [], crew: [] },
        recommendations: { results: [{ id: 99, title: 'TMDB pick', release_date: '2020-01-01' }] },
        videos: { results: [] },
        external_ids: { imdb_id: 'tt1234567' },
        release_dates: { results: [] },
        'watch/providers': { results: {} },
        results: [],
        episodes: [],
      });
    },
  });
  seen.authority = authority;
  seen.ask = (request, policy) => authority.query(request, new AbortController().signal, policy);
  return seen;
}

const refs = (...keys: string[]) =>
  keys.map((key) => ({ type: key.split(':')[0] as 'movie' | 'tv', id: Number(key.split(':')[1]) }));

beforeEach(() => forgetReused());

describe('policy on every atlas request', () => {
  const titleBody = { titles: [{ type: 'movie', id: 1, title: 'One' }] };

  it('sends a Kid policy on a row, a chart, the shared billboard, related lists and a query', async () => {
    const w = world((url) => {
      if (url.includes('/recommend/')) return json({ slides: [] });
      if (url.includes('/catalog/')) return json({ metas: [] });
      if (url.includes('/index/suggest/') || url.includes('/index/similar/'))
        return json({ ids: [1], mixed: [{ type: 'movie', id: 1 }], titles: [] });
      return json({ ...titleBody, order: 'stable', counts: {} });
    });
    await w.ask({ kind: 'atlas.row', type: 'movie', where: { subgenre: 'Heist' }, page: 2 }, KID);
    await w.ask(
      { kind: 'atlas.service.chart', catalog: { id: 'nfx-new', type: 'movie' }, country: 'FI' },
      KID,
    );
    await w.ask(
      { kind: 'atlas.recommend.shared', scope: 'home', fresh: false, day: '2026-10-13' },
      KID,
    );
    await w.ask(
      {
        kind: 'atlas.related',
        query: {
          operation: 'list',
          source: 'similar',
          title: { type: 'movie', id: 1 },
          mixed: false,
        },
      },
      KID,
    );
    await w.ask(
      {
        kind: 'atlas.related',
        query: { operation: 'cards', title: { type: 'movie', id: 1 }, skip: 0, limit: 24 },
      },
      KID,
    );
    await w.ask(
      {
        kind: 'atlas.related',
        query: { operation: 'franchise', title: { type: 'movie', id: 1 } },
      },
      KID,
    );
    await w.ask(
      {
        kind: 'atlas.query',
        query: { operation: 'titles', cursor: 'a', type: 'movie', items: [], page: 1 },
      },
      KID,
    );
    await w.ask(
      { kind: 'atlas.query', query: { operation: 'counts', type: 'movie', items: [] } },
      KID,
    );
    expect(w.atlas).toHaveLength(8);
    for (const url of w.atlas) expect(url, url).toContain(KID_QUERY);
  });

  it('asks the policy-aware GET for suggestions where the POST has no policy', async () => {
    const w = world((url) =>
      url.includes('/index/suggest/')
        ? json({ mixed: [{ type: 'movie', id: 1 }], ids: [1] })
        : undefined,
    );
    const answer = await w.ask(
      {
        kind: 'atlas.related',
        query: { operation: 'suggest', title: { type: 'movie', id: 1 }, mixed: true },
      },
      LITTLE,
    );
    expect(answer).toMatchObject({
      answer: { state: 'ready', value: { operation: 'refs', refs: [{ type: 'movie', id: 1 }] } },
    });
    expect(w.atlas).toEqual([
      '/atlas/index/suggest/movie/1.json?skip=0&limit=100&maximumAge=7&unknownRatings=block&kidAudience=child',
    ]);
    // The unrestricted household keeps its POST.
    const owner = world(() => json({ perSeed: [] }));
    await owner.ask({
      kind: 'atlas.related',
      query: { operation: 'suggest', title: { type: 'movie', id: 1 }, mixed: true },
    });
    expect(owner.atlas[0]).toMatch(/^\/atlas\/index\/suggest\.json \{"seeds"/);
  });

  it('writes the policy into a personalised recommendation, and leaves an Owner with none untouched', async () => {
    const body = {
      version: 1 as const,
      surface: 'home' as const,
      now: '2026-10-13T00:00:00.000Z',
      services: [],
      library: [],
      owned: [],
      hide: { minYear: 1900, genres: [], languages: [], anime: false },
    };
    const w = world(() => json({ slides: [] }));
    await w.ask({ kind: 'atlas.recommend.personal', body }, KID);
    await w.ask({ kind: 'atlas.recommend.personal', body });
    const [kid, owner] = w.atlas.map((line) => JSON.parse(line.slice('/atlas/recommend '.length)));
    expect(kid).toMatchObject({
      maximumAge: 12,
      unknownRatings: 'block',
      kidAudience: 'child-or-teen',
    });
    expect(owner).not.toHaveProperty('maximumAge');
    expect(owner).not.toHaveProperty('kidAudience');
  });

  it('gives an Owner ceiling the age policy without the Kid audience gate, and Visitor the same', async () => {
    const w = world(() => json({ titles: [] }));
    await w.ask({ kind: 'atlas.row', type: 'movie', where: { mood: 'Tense' }, page: 1 }, CEILING);
    expect(w.atlas[0]).toContain('maximumAge=13&unknownRatings=allow');
    expect(w.atlas[0]).not.toContain('kidAudience');
  });

  it('keeps an unrestricted Owner on the URLs it always used', async () => {
    const w = world(() => json({ titles: [] }));
    await w.ask({ kind: 'atlas.row', type: 'movie', where: { mood: 'Tense' }, page: 1 });
    expect(w.atlas).toEqual(['/atlas/index/row/movie.json?mood=Tense&skip=0&limit=24']);
  });
});

describe('cache separation across a profile switch', () => {
  it('never answers one policy from another policy’s row, chart or billboard', async () => {
    let answers = 0;
    const w = world((url) => {
      answers++;
      if (url.includes('/recommend/')) return json({ slides: [{ type: 'movie', id: answers }] });
      return json({ titles: [{ type: 'movie', id: answers, title: `T${answers}` }] });
    });
    const row = { kind: 'atlas.row' as const, type: 'movie' as const, where: { a: 'b' }, page: 1 };
    const billboard = {
      kind: 'atlas.recommend.shared' as const,
      scope: 'home' as const,
      fresh: false,
      day: '2026-10-13',
    };
    const owner = await w.ask(row);
    const kid = await w.ask(row, KID);
    const again = await w.ask(row);
    const little = await w.ask(row, LITTLE);
    expect(w.atlas).toHaveLength(3);
    expect(owner).not.toEqual(kid);
    expect(again).toEqual(owner);
    expect(little).not.toEqual(kid);

    await w.ask(billboard);
    await w.ask(billboard, KID);
    await w.ask(billboard, KID);
    const billboards = w.atlas.filter((url) => url.includes('/recommend/'));
    expect(billboards).toHaveLength(2);
    expect(billboards[0]).not.toContain('maximumAge');
    expect(billboards[1]).toContain(KID_QUERY);
  });

  it('refuses to continue a title cursor under another policy', async () => {
    const w = world(() =>
      json({ order: 'stable', titles: [{ type: 'movie', id: 1, title: 'One' }] }),
    );
    const page = (page: number): ContentRequest => ({
      kind: 'atlas.query',
      query: { operation: 'titles', cursor: 'shared', type: 'movie', items: [], page },
    });
    await w.ask(page(1), KID);
    await expect(w.ask(page(2), LITTLE)).rejects.toMatchObject({
      failure: { code: 'invalid-request', provider: 'atlas' },
    });
  });

  it('keeps an eligibility answer to the policy it was asked under', async () => {
    const w = world();
    const ask = (policy?: ContentPolicy) =>
      w.ask({ kind: 'title.eligibility', titles: refs('movie:2') }, policy);
    await expect(ask(KID)).resolves.toMatchObject({ allowed: refs('movie:2') });
    await expect(ask(LITTLE)).resolves.toMatchObject({ allowed: [] });
    await expect(ask(KID)).resolves.toMatchObject({ allowed: refs('movie:2') });
  });
});

describe('a title only a non-atlas source names', () => {
  it('is hidden from a Kid in a TMDB list, a collection, a filmography and a search', async () => {
    const w = world((url) =>
      url.startsWith('/atlas/index/query.json')
        ? json({ hits: [], people: [] })
        : url.includes('/catalog/') || url.includes('/index/')
          ? json({ metas: [], titles: [], ids: [] })
          : undefined,
    );
    const lists: ContentRequest[] = [
      {
        kind: 'catalog.page',
        catalog: { kind: 'trending', media: 'movie', window: 'week' },
        page: 1,
      },
      {
        kind: 'catalog.page',
        catalog: { kind: 'recommendations', title: { type: 'movie', id: 1 } },
        page: 1,
      },
      { kind: 'collection', id: 10 },
    ];
    for (const list of lists) await expect(w.ask(list, KID)).resolves.toMatchObject({ titles: [] });
    await expect(w.ask({ kind: 'person.filmography', id: 7 }, KID)).resolves.toMatchObject({
      credits: { state: 'absent' },
    });
    await w.ask({ kind: 'search', query: 'heist' }, KID);
    expect(w.tmdb, 'TMDB was not asked for any list, collection, filmography or search').toEqual(
      [],
    );
    expect(w.atlas.every((url) => url.includes(KID_QUERY))).toBe(true);
  });

  it('keeps an Owner ceiling that admits unknown ratings on today’s TMDB surfaces, with the boundary check intact', async () => {
    const w = world();
    await w.ask({ kind: 'collection', id: 10 }, CEILING);
    await w.ask({ kind: 'person.filmography', id: 7 }, CEILING);
    expect(w.tmdb.length).toBe(2);
    const detail = (await w.ask(
      { kind: 'title.detail', title: { type: 'movie', id: 1 }, region: 'FI' },
      CEILING,
    )) as { detail: { value: { more: unknown[] } } };
    expect(detail.detail.value.more).toHaveLength(1);
    // Age 15 is over the ceiling of 13, and that still refuses.
    await expect(
      w.ask({ kind: 'title.detail', title: { type: 'movie', id: 3 }, region: 'FI' }, CEILING),
    ).resolves.toMatchObject({ detail: { reason: 'refused' } });
  });

  it('still serves the same lists to an unrestricted Owner', async () => {
    const w = world();
    await w.ask({ kind: 'collection', id: 10 });
    await w.ask({ kind: 'person.filmography', id: 7 });
    expect(w.tmdb.length).toBe(2);
  });

  it('hydrates only the titles the store establishes, and nothing when the store is down', async () => {
    const w = world();
    const all = refs('movie:1', 'movie:2', 'movie:3', 'movie:4', 'tv:5', 'movie:404');
    const kid = (await w.ask({ kind: 'titles', titles: all }, KID)) as {
      titles: Array<{ id: number }>;
      retryable: unknown[];
    };
    // 15 is over the ceiling, unknown and never-heard-of are blocked, and none is a retry.
    expect(kid.titles.map((title) => title.id)).toEqual([1, 2, 5]);
    expect(kid.retryable).toEqual([]);
    const owner = (await world().ask({ kind: 'titles', titles: all })) as { titles: unknown[] };
    expect(owner.titles).toHaveLength(6);

    // Ages already read are kept for a few minutes; an outage after that is a refusal, not a pass.
    forgetReused();
    const down = world(undefined, { atlasDown: true });
    await expect(down.ask({ kind: 'titles', titles: all }, KID)).resolves.toMatchObject({
      titles: [],
      retryable: [],
    });
    const unconfigured = world(undefined, { atlas: false });
    await expect(unconfigured.ask({ kind: 'titles', titles: all }, KID)).resolves.toMatchObject({
      titles: [],
    });
  });

  it('lets an Owner ceiling treat an unknown rating as the policy says', async () => {
    const w = world();
    const answer = (await w.ask(
      { kind: 'titles', titles: refs('movie:3', 'movie:4') },
      CEILING,
    )) as {
      titles: Array<{ id: number }>;
    };
    expect(answer.titles.map((title) => title.id)).toEqual([4]);
  });
});

describe('every direct boundary asks the same check', () => {
  const direct = (id: number): ContentRequest[] => [
    { kind: 'title.detail', title: { type: 'movie', id }, region: 'FI' },
    { kind: 'prefetch.detail', title: { type: 'movie', id }, region: 'FI' },
    { kind: 'title.external-id', title: { type: 'movie', id } },
    { kind: 'title.extras', title: { type: 'movie', id }, warningCategories: [] },
    { kind: 'season', title: { type: 'tv', id }, season: 1 },
  ];

  it('refuses an over-age title at detail, prefetch, imdb id (play/sources/remux), extras and seasons', async () => {
    const w = world();
    const results = await Promise.all(direct(3).map((request) => w.ask(request, KID)));
    expect(results).toMatchObject([
      { detail: { state: 'unavailable', provider: 'atlas', reason: 'refused' } },
      { kind: 'prefetch.detail' },
      { imdbId: { state: 'unavailable', reason: 'refused' } },
      { extras: { ratings: { state: 'unavailable', reason: 'refused' } } },
      { episodes: { state: 'unavailable', reason: 'refused' } },
    ]);
    expect(w.tmdb, 'no provider read for a title the policy refused').toEqual([]);
  });

  it('serves the allowed title, without TMDB’s own recommendations', async () => {
    const w = world();
    const detail = (await w.ask(direct(1)[0]!, KID)) as {
      detail: { state: string; value: { more: unknown[]; title: { id: number } } };
    };
    expect(detail.detail.state).toBe('ready');
    expect(detail.detail.value.title.id).toBe(1);
    expect(detail.detail.value.more).toEqual([]);
    const owner = (await world().ask(direct(1)[0]!)) as { detail: { value: { more: unknown[] } } };
    expect(owner.detail.value.more).toHaveLength(1);
  });

  it('fails closed for a title the store cannot age, and never refuses the unrestricted household', async () => {
    const unknown = world();
    await expect(unknown.ask(direct(4)[0]!, KID)).resolves.toMatchObject({
      detail: { reason: 'refused' },
    });
    const down = world(undefined, { atlasDown: true });
    await expect(down.ask(direct(1)[0]!, KID)).resolves.toMatchObject({
      detail: { reason: 'refused' },
    });
    const none = world(undefined, { atlas: false });
    await expect(none.ask(direct(1)[0]!, KID)).resolves.toMatchObject({
      detail: { reason: 'refused' },
    });
    await expect(none.ask(direct(1)[0]!)).resolves.toMatchObject({ detail: { state: 'ready' } });
  });

  it('treats missing evidence as an unknown maturity, which the policy’s unknownRatings decides', async () => {
    forgetReused();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const down = world(undefined, { atlasDown: true });
    const ask = (policy: ContentPolicy) =>
      down.ask({ kind: 'title.eligibility', titles: refs('movie:1') }, policy);
    await expect(ask(KID)).resolves.toMatchObject({ allowed: [] });
    // An Owner with a migrated ceiling stays fail-open for what it cannot age (den#234).
    await expect(ask(CEILING)).resolves.toMatchObject({ allowed: refs('movie:1') });
    const none = world(undefined, { atlas: false });
    await expect(
      none.ask({ kind: 'title.eligibility', titles: refs('movie:1') }, CEILING),
    ).resolves.toMatchObject({ allowed: refs('movie:1') });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('answers eligibility in the order asked, bounded and in one request kind', async () => {
    const w = world();
    const asked = refs('tv:5', 'movie:3', 'movie:1');
    await expect(w.ask({ kind: 'title.eligibility', titles: asked }, KID)).resolves.toEqual({
      kind: 'title.eligibility',
      allowed: refs('tv:5', 'movie:1'),
    });
    const spy = vi.fn();
    await world().ask({ kind: 'title.eligibility', titles: asked }).then(spy);
    expect(spy).toHaveBeenCalledWith({ kind: 'title.eligibility', allowed: asked });
  });
});
