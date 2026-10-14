import { describe, expect, it, vi } from 'vitest';
import type { ContentServiceClientPort } from './contentServiceClient';
import {
  decodeContentServiceClientMessage,
  decodeContentServiceServerMessage,
} from './contentServiceProtocolCodec';
import { CONTENT_SERVICE_PROTOCOL } from './contentServiceProtocol';
import { HouseholdSession } from './householdSession.svelte';
import type { LibraryModel } from './libraryModel.svelte';
import { persistentProfileIdentity } from './profileIdentity';
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

  it('names nothing when the check cannot be asked', async () => {
    const { session: kid, query } = session({
      policy: { maximumAge: 12, unknownRatings: 'block' },
      kid: true,
    });
    query.mockRejectedValueOnce(new Error('offline'));
    expect((await kid.libraryMetadata(refs)).titles).toEqual([]);
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
      null,
      false,
      false,
      household.policy,
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

  it('is the household’s for Kid and Owner alike, never the Kid’s own setting', async () => {
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
    // The Kid's own projection names another region (and the Owner's names none): neither is consulted.
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
    ).toEqual(['SE', 'SE']);
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
