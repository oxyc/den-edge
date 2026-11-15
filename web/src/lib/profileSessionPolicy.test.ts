import { describe, expect, it, vi } from 'vitest';
import { ContentAuthority, WorkerContentCredentials } from './contentAuthority';
import { ContentServiceError, type ContentServiceClientPort } from './contentServiceClient';
import { ContentServiceFault } from './contentServiceCore';
import {
  decodeContentServiceClientMessage,
  decodeContentServiceServerMessage,
} from './contentServiceProtocolCodec';
import { CONTENT_SERVICE_PROTOCOL } from './contentServiceProtocol';
import { HouseholdSession } from './householdSession.svelte';
import type { LibraryModel } from './libraryModel.svelte';
import { nameLibraryTitles } from './libraryNaming';
import { persistentProfileIdentity } from './profileIdentity';
import { profilePolicy } from './profilePolicy';
import { ProfileSession } from './profileSession.svelte';

function session(options: {
  policy: { maximumAge: number | null; unknownRatings: 'allow' | 'block' } | null;
  kid: boolean;
  allowed?: Array<{ type: 'movie' | 'tv'; id: number }>;
}) {
  const query = vi.fn(async (request: { kind: string; titles?: unknown[] }) => ({
    kind: request.kind,
    allowed: options.allowed ?? [],
  }));
  const content = { query, onStatus: () => () => {} } as unknown as ContentServiceClientPort;
  const household = new HouseholdSession(
    { kind: 'legacy', libraryKey: 'household', configurationOnly: false },
    null,
    content,
  );
  const named = [
    { type: 'movie' as const, id: 1, title: 'One' },
    { type: 'movie' as const, id: 3, title: 'Three' },
    { type: 'tv' as const, id: 5, title: 'Five' },
  ];
  const model = {
    libraryMetadata: vi.fn(async () => ({
      titles: named,
      shapes: [{ title: { type: 'tv' as const, id: 5 }, seasons: [], lastAired: undefined }],
      retryable: [{ type: 'movie' as const, id: 3 }],
    })),
  } as unknown as LibraryModel;
  return {
    query,
    session: new ProfileSession(
      persistentProfileIdentity('b'.repeat(32), 'key'),
      household,
      model,
      false,
      false,
      undefined,
      null,
      options.policy,
      null,
      null,
      !options.kid,
      options.kid,
    ),
  };
}

describe('a restricted profile names only the titles its policy establishes', () => {
  const refs = [
    { type: 'movie' as const, id: 1 },
    { type: 'movie' as const, id: 3 },
    { type: 'tv' as const, id: 5 },
  ];

  it('drops the library’s titles, shapes and retries for what the shared check did not allow', async () => {
    const { session: kid, query } = session({
      policy: { maximumAge: 12, unknownRatings: 'block' },
      kid: true,
      allowed: [
        { type: 'movie', id: 1 },
        { type: 'tv', id: 5 },
      ],
    });
    const found = await kid.libraryMetadata(refs);
    expect(found.titles.map((title) => title.id)).toEqual([1, 5]);
    expect(found.shapes.map((shape) => shape.title.id)).toEqual([5]);
    // Not a transient failure: the ineligible title is absent, so it is not asked for again.
    expect(found.retryable).toEqual([]);
    expect(query).toHaveBeenCalledWith({ kind: 'title.eligibility', titles: refs }, undefined, {
      maximumAge: 12,
      unknownRatings: 'block',
      kidAudience: 'child-or-teen',
    });
  });

  it('keeps a failed check as a retryable question rather than an empty answer', async () => {
    const { session: kid, query } = session({
      policy: { maximumAge: 12, unknownRatings: 'block' },
      kid: true,
    });
    query.mockRejectedValueOnce(new Error('offline'));
    await expect(kid.libraryMetadata(refs)).rejects.toThrow('offline');
  });

  it('retries an Atlas outage only for the current profile and provider generation', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const credentials = new WorkerContentCredentials();
      credentials.configureAtlas('/atlas-a');
      let releaseStale!: () => void;
      const staleGate = new Promise<void>((resolve) => (releaseStale = resolve));
      let staleStarted!: () => void;
      const sawStale = new Promise<void>((resolve) => (staleStarted = resolve));
      let bDown = true;
      let atlasACalls = 0,
        atlasBCalls = 0;
      const tmdbFetch = vi.fn(async (input: RequestInfo | URL) => {
        const id = Number(/\/(?:movie|tv)\/(\d+)/.exec(String(input))?.[1] ?? 0);
        return new Response(
          JSON.stringify({
            id,
            title: `Title ${id}`,
            release_date: '2020-01-01',
            credits: { cast: [], crew: [] },
            recommendations: { results: [] },
            videos: { results: [] },
            external_ids: {},
            release_dates: { results: [] },
            'watch/providers': { results: {} },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      });
      const authority = new ContentAuthority(credentials, {
        providerFetch: async (input) => {
          const url = String(input);
          if (url.startsWith('/atlas-a/')) {
            atlasACalls++;
            staleStarted();
            await staleGate;
            return new Response(JSON.stringify({ minimumAge: 7, eligible: true }), {
              headers: { 'content-type': 'application/json' },
            });
          }
          if (url.startsWith('/atlas-b/')) {
            atlasBCalls++;
            return new Response(
              JSON.stringify(bDown ? { error: 'down' } : { minimumAge: 7, eligible: true }),
              {
                status: bDown ? 503 : 200,
                headers: { 'content-type': 'application/json' },
              },
            );
          }
          throw new Error(`unexpected provider request: ${url}`);
        },
        tmdbFetch,
      });
      const content = {
        query: async (request, signal, policy) => {
          try {
            return await authority.query(request, signal ?? new AbortController().signal, policy);
          } catch (error) {
            if (error instanceof ContentServiceFault) throw new ContentServiceError(error.failure);
            throw error;
          }
        },
        onStatus: () => () => {},
      } as ContentServiceClientPort;
      const model = {
        libraryMetadata: vi.fn(async () => ({
          titles: [{ type: 'movie' as const, id: 1, title: 'One' }],
          shapes: [],
          retryable: [],
        })),
      } as unknown as LibraryModel;
      const open = (id: string) => {
        const household = new HouseholdSession(
          { kind: 'legacy', libraryKey: 'household', configurationOnly: false },
          model,
          content,
        );
        return new ProfileSession(
          persistentProfileIdentity(id.repeat(32), 'key'),
          household,
          model,
          false,
          false,
          undefined,
          null,
          { maximumAge: null, unknownRatings: 'allow' },
          null,
          null,
          false,
          true,
        );
      };

      const stale = open('b');
      const staleNaming = nameLibraryTitles(stale, [refs[0]!]);
      await sawStale;
      stale.close();
      credentials.configureAtlas('/atlas-b');

      const current = open('c');
      await nameLibraryTitles(current, [refs[0]!]);
      expect(current.displayMissing(refs[0]!)).toBe(false);
      expect([...current.displayTitles().values()]).toEqual([]);
      const unavailable = await current.content.query({
        kind: 'title.detail',
        title: refs[0]!,
        region: 'US',
      });
      expect(unavailable.detail).toMatchObject({
        state: 'unavailable',
        provider: 'atlas',
        reason: 'network',
      });
      expect(tmdbFetch).not.toHaveBeenCalled();

      bDown = false;
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() =>
        expect([...current.displayTitles().values()]).toEqual([
          { type: 'movie', id: 1, title: 'One' },
        ]),
      );
      await expect(
        current.content.query({ kind: 'title.detail', title: refs[0]!, region: 'US' }),
      ).resolves.toMatchObject({ detail: { state: 'ready' } });
      expect(tmdbFetch).toHaveBeenCalledTimes(1);

      releaseStale();
      await staleNaming;
      expect([...stale.displayTitles().values()]).toEqual([]);
      expect([atlasACalls, atlasBCalls]).toEqual([1, 3]);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('leaves an unrestricted profile’s library naming exactly as the library answered', async () => {
    const { session: owner, query } = session({
      policy: { maximumAge: null, unknownRatings: 'allow' },
      kid: false,
    });
    expect((await owner.libraryMetadata(refs)).titles).toHaveLength(3);
    expect(query).not.toHaveBeenCalled();
    expect(owner.content).toBe(owner.household.content);
    expect(owner.policyKey).toBeUndefined();
  });

  it('holds a Kid with no readable policy to the strictest one', async () => {
    const { session: kid, query } = session({ policy: null, kid: true });
    expect(kid.restricted).toBe(true);
    expect(kid.policyKey).toBe('0_block_-_child');
    await kid.content.query({ kind: 'collection', id: 1 });
    expect(query).toHaveBeenLastCalledWith({ kind: 'collection', id: 1 }, undefined, {
      maximumAge: 0,
      unknownRatings: 'block',
      kidAudience: 'child',
    });
  });
});

describe('the watch region', () => {
  it('is waited for once, so every request names the same region and no cache splits', async () => {
    let settle!: () => void;
    const ready = new Promise<void>((resolve) => (settle = resolve));
    const settings: { value?: unknown } = {};
    const query = vi.fn(async () => ({ kind: 'collection', titles: [] }));
    const content = { query, onStatus: () => () => {} } as unknown as ContentServiceClientPort;
    const model = {
      ready,
      get settings() {
        return settings;
      },
    } as unknown as LibraryModel;
    const household = new HouseholdSession(
      { kind: 'legacy', libraryKey: 'household', configurationOnly: false },
      model,
      content,
    );
    const kid = new ProfileSession(
      persistentProfileIdentity('b'.repeat(32), 'key'),
      household,
      model,
      false,
      false,
      profilePolicy(model),
      null,
      { maximumAge: 12, unknownRatings: 'block' },
      null,
      null,
      false,
      true,
    );
    const first = kid.content.query({ kind: 'collection', id: 1 });
    await Promise.resolve();
    expect(query).not.toHaveBeenCalled();
    settings.value = { kind: 'settings', preferences: { watchRegion: 'fi', services: [] } };
    settle();
    await first;
    await kid.content.query({ kind: 'collection', id: 2 });
    const sent = {
      maximumAge: 12,
      unknownRatings: 'block',
      kidAudience: 'child-or-teen',
      region: 'FI',
    };
    expect(query.mock.calls.map((call) => (call as unknown[])[2])).toEqual([sent, sent]);
  });

  it('is the one this browser last read, at once, and the settled one is kept for next time', async () => {
    const regionKey = `den.profile.watch-region.v1:${'b'.repeat(32)}`;
    const kept = new Map<string, string>([[regionKey, 'SE']]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => kept.set(key, value),
      removeItem: (key: string) => kept.delete(key),
    });
    try {
      let settle!: () => void;
      const ready = new Promise<void>((resolve) => (settle = resolve));
      const settings: { value?: unknown } = {};
      const query = vi.fn(async () => ({ kind: 'collection', titles: [] }));
      const content = { query, onStatus: () => () => {} } as unknown as ContentServiceClientPort;
      const model = {
        ready,
        get settings() {
          return settings;
        },
      } as unknown as LibraryModel;
      const household = new HouseholdSession(
        { kind: 'legacy', libraryKey: 'household', configurationOnly: false },
        model,
        content,
      );
      const kid = new ProfileSession(
        persistentProfileIdentity('b'.repeat(32), 'key'),
        household,
        model,
        false,
        false,
        profilePolicy(model),
        null,
        { maximumAge: 12, unknownRatings: 'block' },
        null,
        null,
        false,
        true,
      );
      // Sent before the settings arrive, under the remembered region.
      await kid.content.query({ kind: 'collection', id: 1 });
      expect((query.mock.calls[0] as unknown[])[2]).toMatchObject({ region: 'SE' });

      settings.value = { kind: 'settings', preferences: { watchRegion: 'fi', services: [] } };
      settle();
      await expect.poll(() => kept.get(regionKey)).toBe('FI');
      // The session keeps the region it started with, so its cache is never split.
      await kid.content.query({ kind: 'collection', id: 2 });
      expect((query.mock.calls[1] as unknown[])[2]).toMatchObject({ region: 'SE' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is each profile’s own, never the household’s or another profile’s', async () => {
    const query = vi.fn(async () => ({ kind: 'collection', titles: [] }));
    const content = { query, onStatus: () => () => {} } as unknown as ContentServiceClientPort;
    const model = {
      ready: Promise.resolve(),
      settings: {
        connection: 'ready',
        value: { kind: 'settings', preferences: { watchRegion: 'se', services: [] } },
      },
    } as unknown as LibraryModel;
    const household = new HouseholdSession(
      { kind: 'legacy', libraryKey: 'household', configurationOnly: false },
      model,
      content,
    );
    // The household names Sweden; each profile's own projection is what its session reads, the Owner's naming none.
    const own = (watchRegion?: string) =>
      ({
        settings: {
          connection: 'ready',
          value: { kind: 'settings', preferences: { watchRegion, services: [] } },
        },
      }) as unknown as typeof household.policy;
    const open = (kid: boolean, policy: typeof household.policy) =>
      new ProfileSession(
        persistentProfileIdentity((kid ? 'b' : 'c').repeat(32), 'key'),
        household,
        null,
        false,
        !kid,
        policy,
        null,
        kid
          ? { maximumAge: 12, unknownRatings: 'block' }
          : { maximumAge: 13, unknownRatings: 'allow' },
        null,
        null,
        !kid,
        kid,
      );
    await open(true, own('us')).content.query({ kind: 'collection', id: 1 });
    await open(false, own(undefined)).content.query({ kind: 'collection', id: 1 });
    expect(
      query.mock.calls.map((call) => ((call as unknown[])[2] as { region?: string }).region),
    ).toEqual(['US', undefined]);
  });
});

describe('the content protocol carries the policy', () => {
  const message = (extra: Record<string, unknown>) => ({
    type: 'content-query',
    protocol: CONTENT_SERVICE_PROTOCOL,
    requestId: 'r:1',
    request: { kind: 'title.eligibility', titles: [{ type: 'movie', id: 1 }] },
    ...extra,
  });

  it('accepts a valid policy and none, and refuses a malformed or looser-than-possible one', () => {
    expect(decodeContentServiceClientMessage(message({})).ok).toBe(true);
    for (const policy of [
      { maximumAge: 12, unknownRatings: 'block' },
      { maximumAge: null, unknownRatings: 'allow', kidAudience: 'child' },
    ])
      expect(
        decodeContentServiceClientMessage(message({ policy })).ok,
        JSON.stringify(policy),
      ).toBe(true);
    for (const policy of [
      { maximumAge: 19, unknownRatings: 'block' },
      { maximumAge: 'pg13', unknownRatings: 'block' },
      { maximumAge: 12, unknownRatings: 'maybe' },
      { maximumAge: 12, unknownRatings: 'block', kidAudience: 'family' },
      { maximumAge: 12, unknownRatings: 'block', extra: true },
      { unknownRatings: 'block' },
      'kid',
    ])
      expect(
        decodeContentServiceClientMessage(message({ policy })).ok,
        JSON.stringify(policy),
      ).toBe(false);
  });

  it('refuses a Worker from before the policy existed rather than ask it unrestricted questions', () => {
    expect(CONTENT_SERVICE_PROTOCOL).toBeGreaterThanOrEqual(5);
    expect(decodeContentServiceClientMessage(message({ protocol: 4 }))).toMatchObject({
      ok: false,
      error: { code: 'protocol-mismatch' },
    });
  });

  it('validates the eligibility request and its answer', () => {
    expect(
      decodeContentServiceClientMessage(
        message({ request: { kind: 'title.eligibility', titles: [{ type: 'anime', id: 1 }] } }),
      ).ok,
    ).toBe(false);
    expect(
      decodeContentServiceServerMessage({
        type: 'content-result',
        protocol: CONTENT_SERVICE_PROTOCOL,
        requestId: 'r:1',
        result: { kind: 'title.eligibility', allowed: [{ type: 'tv', id: 5 }] },
      }).ok,
    ).toBe(true);
    expect(
      decodeContentServiceServerMessage({
        type: 'content-result',
        protocol: CONTENT_SERVICE_PROTOCOL,
        requestId: 'r:1',
        result: { kind: 'title.eligibility', allowed: true },
      }).ok,
    ).toBe(false);
  });
});
