import { describe, expect, it, vi } from 'vitest';
import {
  ageAllowed,
  atlasPolicyFields,
  contentPolicyFor,
  isRestricted,
  kidAudienceFor,
  PolicedContent,
  policedAtlasFetch,
  policyKey,
} from './contentPolicy';
import type { ContentServiceClientPort } from './contentServiceClient';
import type { ContentPolicy } from './contentServiceProtocol';

const kid: ContentPolicy = {
  maximumAge: 12,
  unknownRatings: 'block',
  kidAudience: 'child-or-teen',
};
const ceilinged: ContentPolicy = { maximumAge: 13, unknownRatings: 'allow' };

describe('contentPolicyFor', () => {
  it('has no policy for an Owner without a ceiling, so the legacy path sends nothing extra', () => {
    expect(contentPolicyFor({ maximumAge: null, unknownRatings: 'allow' }, false)).toBeUndefined();
    expect(contentPolicyFor(null, false)).toBeUndefined();
  });

  it('keeps an Owner ceiling and an unknown-rating block without an audience gate', () => {
    expect(contentPolicyFor({ maximumAge: 13, unknownRatings: 'allow' }, false)).toEqual(ceilinged);
    expect(contentPolicyFor({ maximumAge: null, unknownRatings: 'block' }, false)).toEqual({
      maximumAge: null,
      unknownRatings: 'block',
    });
  });

  it('adds the audience gate for a Kid: child under 12, child-or-teen from 12 and with no ceiling', () => {
    expect(kidAudienceFor(11)).toBe('child');
    expect(kidAudienceFor(12)).toBe('child-or-teen');
    expect(kidAudienceFor(18)).toBe('child-or-teen');
    expect(kidAudienceFor(null)).toBe('child-or-teen');
    expect(contentPolicyFor({ maximumAge: 8, unknownRatings: 'block' }, true)).toMatchObject({
      kidAudience: 'child',
    });
    // A Kid that is allowed everything by age is still a Kid catalogue.
    expect(contentPolicyFor({ maximumAge: null, unknownRatings: 'allow' }, true)).toEqual({
      maximumAge: null,
      unknownRatings: 'allow',
      kidAudience: 'child-or-teen',
    });
  });

  it('holds a Kid with no readable policy to the strictest one, never to none', () => {
    expect(contentPolicyFor(null, true)).toEqual({
      maximumAge: 0,
      unknownRatings: 'block',
      kidAudience: 'child',
    });
  });
});

describe('policy identity', () => {
  it('spells every input, so no two policies share a cache key', () => {
    expect(policyKey(undefined)).toBe('-');
    expect(policyKey({ maximumAge: null, unknownRatings: 'allow' })).toBe('-');
    expect(policyKey(kid)).toBe('12_block_child-or-teen');
    const keys = new Set([
      policyKey(kid),
      policyKey({ ...kid, kidAudience: 'child' }),
      policyKey({ ...kid, maximumAge: 13 }),
      policyKey({ ...kid, unknownRatings: 'allow' }),
      policyKey({ maximumAge: null, unknownRatings: 'block' }),
      policyKey(ceilinged),
    ]);
    expect(keys.size).toBe(6);
    expect(isRestricted(ceilinged)).toBe(true);
    expect(isRestricted({ maximumAge: null, unknownRatings: 'allow' })).toBe(false);
  });

  it('names every field den-atlas reads, always spelling out unknownRatings', () => {
    expect(atlasPolicyFields(kid)).toEqual([
      ['maximumAge', '12'],
      ['unknownRatings', 'block'],
      ['kidAudience', 'child-or-teen'],
    ]);
    // Atlas defaults an absent unknownRatings to `block` beside a ceiling: an Owner's `allow` must be explicit.
    expect(atlasPolicyFields(ceilinged)).toEqual([
      ['maximumAge', '13'],
      ['unknownRatings', 'allow'],
    ]);
    expect(atlasPolicyFields(undefined)).toEqual([]);
  });
});

describe('ageAllowed (den-core)', () => {
  it('applies the shared rule: a known age within the ceiling, unknown only when allowed', async () => {
    await expect(ageAllowed(kid, 12)).resolves.toBe(true);
    await expect(ageAllowed(kid, 13)).resolves.toBe(false);
    await expect(ageAllowed(kid, null)).resolves.toBe(false);
    await expect(ageAllowed(ceilinged, null)).resolves.toBe(true);
    await expect(ageAllowed(ceilinged, 17)).resolves.toBe(false);
    await expect(ageAllowed(undefined, 18)).resolves.toBe(true);
    // The audience gate is discovery's; a direct request is age policy only.
    await expect(
      ageAllowed({ maximumAge: null, unknownRatings: 'allow', kidAudience: 'child' }, 18),
    ).resolves.toBe(true);
  });
});

describe('policedAtlasFetch', () => {
  const run = async (policy: ContentPolicy | undefined, path: string, init?: RequestInit) => {
    const inner = vi.fn<typeof fetch>(async () => new Response('{}'));
    await policedAtlasFetch(inner, '/atlas', policy)(`/atlas${path}`, init);
    return inner.mock.calls[0]!;
  };

  it.each([
    '/index/rows/movie/subgenre/Heist.json?skip=24&limit=24',
    '/index/row/movie.json?mood=Tense&skip=0&limit=24',
    '/index/filter/movie/titles.json?sel=genre:35&skip=0&limit=24',
    '/index/filter/all/counts.json',
    '/index/filter/movie/people.json?order=credits',
    '/index/filter/movie/values/person.json?q=bong',
    '/index/query.json?q=heist&limit=40',
    '/index/search.json?q=heist',
    '/index/facets.json?q=korean+heist',
    '/index/similar/movie/603.json',
    '/index/neighbours/movie/603.json?k=24',
    '/index/suggest/movie/603.json?skip=0&limit=24',
    '/index/franchise/movie/603.json',
    '/index/versions/movie/603.json',
    '/index/title/movie/603.json',
    '/catalog/movie/den-titles/search=heist.json',
    '/catalog/series/nfx-new/country=FI.json',
    '/recommend/home.json?day=2026-10-13',
  ])('puts the policy on atlas GET %s, after what it already names', async (path) => {
    const [url] = await run(kid, path);
    expect(url).toBe(
      `/atlas${path}${path.includes('?') ? '&' : '?'}maximumAge=12&unknownRatings=block&kidAudience=child-or-teen`,
    );
  });

  it('sends an Owner with no policy exactly what it sent before', async () => {
    const [url, init] = await run(undefined, '/index/rows/movie/subgenre/Heist.json?limit=24', {
      signal: undefined,
    });
    expect(url).toBe('/atlas/index/rows/movie/subgenre/Heist.json?limit=24');
    expect(init).toEqual({ signal: undefined });
  });

  it('gives an Owner ceiling its age policy and no audience gate', async () => {
    const [url] = await run(ceilinged, '/index/rows/movie/subgenre/Heist.json');
    expect(url).toBe(
      '/atlas/index/rows/movie/subgenre/Heist.json?maximumAge=13&unknownRatings=allow',
    );
  });

  it('leaves the manifest unpoliced and other hosts alone', async () => {
    expect((await run(kid, '/manifest.json'))[0]).toBe('/atlas/manifest.json');
    const inner = vi.fn<typeof fetch>(async () => new Response('{}'));
    await policedAtlasFetch(inner, '/atlas', kid)('https://api.themoviedb.org/3/movie/603');
    expect(inner.mock.calls[0]![0]).toBe('https://api.themoviedb.org/3/movie/603');
  });

  it('writes the policy into the personalised recommendation, over anything the caller put there', async () => {
    const [url, init] = await run(kid, '/recommend', {
      method: 'POST',
      body: JSON.stringify({
        surface: 'home',
        maximumAge: null,
        unknownRatings: 'allow',
        library: [],
      }),
    });
    expect(url).toBe('/atlas/recommend');
    expect(JSON.parse(String(init?.body))).toEqual({
      surface: 'home',
      library: [],
      maximumAge: 12,
      unknownRatings: 'block',
      kidAudience: 'child-or-teen',
    });
  });

  it('removes a ceiling the caller named when the policy has none', async () => {
    const [, init] = await run({ maximumAge: null, unknownRatings: 'block' }, '/recommend', {
      method: 'POST',
      body: JSON.stringify({ surface: 'home', maximumAge: 18 }),
    });
    expect(JSON.parse(String(init?.body))).toEqual({ surface: 'home', unknownRatings: 'block' });
  });

  it('refuses a POST that has no policy-aware form rather than send it unrestricted', async () => {
    const inner = vi.fn<typeof fetch>(async () => new Response('{}'));
    await expect(
      policedAtlasFetch(
        inner,
        '/atlas',
        kid,
      )('/atlas/index/suggest.json', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow(/no policy-aware form/);
    expect(inner).not.toHaveBeenCalled();
  });
});

describe('PolicedContent', () => {
  it('stamps the profile policy on every query', async () => {
    const query = vi.fn(async () => ({ kind: 'catalog.page', titles: [] }));
    const inner = { query, onStatus: () => () => {} } as unknown as ContentServiceClientPort;
    const port = new PolicedContent(inner, () => kid);
    await port.query({ kind: 'catalog.page', catalog: { kind: 'upcoming' }, page: 1 });
    await port.query({ kind: 'title.eligibility', titles: [{ type: 'movie', id: 1 }] });
    expect(query.mock.calls.map((call) => (call as unknown[])[2])).toEqual([kid, kid]);
  });
});
