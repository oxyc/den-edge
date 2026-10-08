import { describe, expect, it } from 'vitest';
import {
  decodeLibraryServiceClientMessage,
  decodeLibraryServiceServerMessage,
} from './libraryServiceProtocolCodec';
import { LIBRARY_SERVICE_PROTOCOL, LIBRARY_SERVICE_WIRE_LIMITS } from './libraryServiceProtocol';

const version = { instance: 'worker-1', generation: 'generation-3', revision: 14 };
const libraryKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

describe('library service client protocol', () => {
  it('accepts a handshake and semantic, idempotent commands', () => {
    expect(
      decodeLibraryServiceClientMessage({
        type: 'hello',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-1',
        clientId: 'tab-1',
        libraryKey,
        mode: 'online',
        legacyClock: {
          device: '0123456789abcdef',
          last: [1_800_000_000_000, 2, 'fedcba9876543210'],
        },
      }),
    ).toMatchObject({ ok: true, value: { type: 'hello' } });

    expect(
      decodeLibraryServiceClientMessage({
        type: 'command',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-2',
        operationId: 'operation-1',
        command: {
          kind: 'progress.record',
          title: { type: 'tv', id: 42 },
          episode: { type: 'tv', id: 42, season: 2, episode: 3 },
          fraction: 0.4,
          seconds: 812,
          observedAt: 1_800_000_000_000,
        },
      }),
    ).toMatchObject({ ok: true, value: { type: 'command', operationId: 'operation-1' } });

    for (const command of [
      { kind: 'watchlist.add', title: { type: 'movie', id: 12 } },
      { kind: 'library.remove', title: { type: 'movie', id: 12 } },
      {
        kind: 'season-watched.set',
        title: { type: 'tv', id: 42 },
        season: 2,
        episodes: [1, 2, 3, 4, 5, 6],
        watched: true,
      },
    ]) {
      expect(
        decodeLibraryServiceClientMessage({
          type: 'command',
          protocol: LIBRARY_SERVICE_PROTOCOL,
          requestId: 'request-command',
          operationId: 'operation-command',
          command,
        }),
      ).toMatchObject({ ok: true });
    }
  });

  it('accepts domain subscriptions without exposing durable rows', () => {
    const decoded = decodeLibraryServiceClientMessage({
      type: 'subscribe',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId: 'request-3',
      subscriptionId: 'visible-posters',
      selection: {
        kind: 'presence',
        titles: [
          { type: 'movie', id: 12 },
          { type: 'tv', id: 34 },
        ],
      },
    });

    expect(decoded).toMatchObject({ ok: true, value: { selection: { kind: 'presence' } } });
    expect(JSON.stringify(decoded)).not.toContain('row');
  });

  it('accepts bounded semantic tasks and rejects row-shaped import payloads', () => {
    const decodeTask = (task: unknown) =>
      decodeLibraryServiceClientMessage({
        type: 'task',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-task',
        operationId: 'operation-task',
        task,
      });

    expect(
      decodeTask({
        kind: 'history.import',
        items: [
          { title: { type: 'movie', id: 12 }, watchedAt: 1_800_000_000_000 },
          {
            title: { type: 'tv', id: 34 },
            episodes: [{ season: 1, episode: 2, watchedAt: 1_800_000_000_001 }],
            complete: false,
          },
        ],
      }),
    ).toMatchObject({ ok: true });
    expect(
      decodeTask({
        kind: 'history.import',
        items: [{ kind: 'rec', schema: 4, title: { type: 'movie', id: 12 } }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      decodeTask({
        kind: 'key-reset.move',
        destinationLibraryKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(3))),
      }),
    ).toMatchObject({ ok: true });
    expect(
      decodeLibraryServiceServerMessage({
        type: 'task-result',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-task',
        operationId: 'operation-task',
        result: { kind: 'history.import', written: 2, total: 2, complete: true },
        version,
      }),
    ).toMatchObject({ ok: true });
  });

  it('accepts the complete semantic preferences patch', () => {
    const decoded = decodeLibraryServiceClientMessage({
      type: 'command',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId: 'request-preferences',
      operationId: 'operation-preferences',
      command: {
        kind: 'preferences.patch',
        patch: {
          excludedGenres: [27, 878],
          excludedLanguages: ['fi', 'sv'],
          hideAnime: true,
          hideWatched: true,
          minReleaseYear: null,
          audioLanguage: 'fi',
          subtitleLanguage: null,
          shownSubtitleLanguages: ['en', 'sv'],
          subtitlesPerLanguage: 0,
          autoSkipSegments: true,
          autoplayTrailers: false,
          ratingSources: { kind: 'values', values: [] },
          shownWarnings: ['Abuse', 'Spoiler'],
          watchRegion: 'FI',
          services: { kind: 'values', values: [] },
          maturityCeiling: 'pg13',
        },
      },
    });

    expect(decoded).toMatchObject({
      ok: true,
      value: {
        command: {
          patch: {
            ratingSources: { kind: 'values', values: [] },
            services: { kind: 'values', values: [] },
          },
        },
      },
    });
  });

  it('accepts only typed connection commands and queries', () => {
    const decodeCommand = (command: unknown) =>
      decodeLibraryServiceClientMessage({
        type: 'command',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-connections',
        operationId: 'operation-connections',
        command,
      });
    for (const command of [
      { kind: 'api-key.set', service: 'tmdb', value: 'key' },
      { kind: 'parental-pin.set', pin: '1234' },
      {
        kind: 'remote-access.set',
        credentials: { clientId: 'client', clientSecret: 'secret' },
      },
      { kind: 'plugin.install', manifestUrl: 'https://addon.example/manifest.json' },
      {
        kind: 'plugin-trust.set',
        manifestUrl: 'https://addon.example/manifest.json',
        publicKey: 'ed25519-key',
      },
      {
        kind: 'server.patch',
        server: 'jellyfin',
        value: { url: 'http://jellyfin.local:8096', user: 'u1', credential: 'token' },
      },
      { kind: 'device.heartbeat', name: 'Living room browser' },
      { kind: 'device.remove', deviceId: 'abcdef0123456789' },
    ])
      expect(decodeCommand(command)).toMatchObject({ ok: true });

    expect(decodeCommand({ kind: 'parental-pin.set', pin: '12345' })).toMatchObject({ ok: false });
    expect(
      decodeCommand({ kind: 'api-key.set', service: 'simkl', value: 'not-in-this-slice' }),
    ).toMatchObject({ ok: false });
    expect(
      decodeCommand({ kind: 'settings.write', group: 'keys', changes: { tmdb: 'secret' } }),
    ).toMatchObject({ ok: false });
    expect(
      decodeCommand({
        kind: 'server.patch',
        server: 'plex',
        value: { url: 'https://plex.example', user: 'not-a-plex-field' },
      }),
    ).toMatchObject({ ok: false });

    for (const query of [
      { kind: 'parental-pin.verify', pin: '1234' },
      { kind: 'relay.membership' },
    ])
      expect(
        decodeLibraryServiceClientMessage({
          type: 'query',
          protocol: LIBRARY_SERVICE_PROTOCOL,
          requestId: 'request-query',
          query,
        }),
      ).toMatchObject({ ok: true });
  });

  it('accepts title-shape and lifecycle observations without route semantics', () => {
    expect(
      decodeLibraryServiceClientMessage({
        type: 'observe',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-4',
        observation: {
          kind: 'title-shape',
          title: { type: 'tv', id: 42 },
          seasons: [
            { season: 1, episodes: 8 },
            { season: 2, episodes: 6 },
          ],
          lastAired: { season: 2, episode: 3 },
        },
      }),
    ).toMatchObject({ ok: true, value: { type: 'observe' } });

    expect(
      decodeLibraryServiceClientMessage({
        type: 'observe',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-5',
        observation: {
          kind: 'lifecycle',
          visible: true,
          online: true,
          playbackActive: false,
        },
      }),
    ).toMatchObject({ ok: true, value: { observation: { kind: 'lifecycle' } } });

    expect(
      decodeLibraryServiceClientMessage({
        type: 'observe',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-6',
        observation: { kind: 'foreground-ready' },
      }),
    ).toMatchObject({ ok: true, value: { observation: { kind: 'foreground-ready' } } });
  });

  it('keeps the SIMKL wire surface semantic and credentials one-way', () => {
    const request = (command: unknown) =>
      decodeLibraryServiceClientMessage({
        type: 'command',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-simkl',
        operationId: 'operation-simkl',
        command,
      });
    expect(request({ kind: 'simkl.connect', token: 'secret' })).toMatchObject({ ok: true });
    expect(request({ kind: 'simkl.disconnect' })).toMatchObject({ ok: true });
    expect(request({ kind: 'simkl.removals.approve', approvalId: 'shown-batch' })).toMatchObject({
      ok: true,
    });
    expect(request({ kind: 'simkl.write-row', row: { credential: 'secret' } })).toMatchObject({
      ok: false,
    });

    expect(
      decodeLibraryServiceServerMessage({
        type: 'update',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        subscriptionId: 'simkl-settings',
        version,
        value: {
          kind: 'simkl',
          connected: true,
          account: '42',
          heldRemovals: [{ type: 'movie', id: 550 }],
          approvalId: 'shown-batch',
        },
      }),
    ).toMatchObject({ ok: true });
  });

  it('accepts only named runtime discovery and retained-Home operations', () => {
    const command = (value: unknown) =>
      decodeLibraryServiceClientMessage({
        type: 'command',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'runtime-command',
        operationId: 'runtime-operation',
        command: value,
      });
    const services = {
      routes: { remux: [{ url: 'https://remux.example', access: true }] },
      scout: { install: 'https://plugins.example/scout', base: '/scout' },
      atlas: '/atlas',
      reel: '/reel',
      remux: 'https://remux.example',
    };
    expect(command({ kind: 'retained.services.set', value: services })).toMatchObject({ ok: true });
    expect(command({ kind: 'retained.home-continue.set', present: true })).toMatchObject({
      ok: true,
    });
    expect(
      command({
        kind: 'retained.billboard.set',
        scope: { kind: 'personal', facet: 'movie', fresh: false },
        value: {
          kind: 'personal',
          at: 1_800_000_000_000,
          titles: [{ type: 'movie', id: 7, title: 'Seven', why: { reason: 'similar' } }],
        },
      }),
    ).toMatchObject({ ok: true });
    expect(command({ kind: 'cache.set', name: 'anything', value: { secret: true } })).toMatchObject(
      { ok: false },
    );
    expect(
      command({
        kind: 'retained.billboard.set',
        scope: { kind: 'shared', facet: null, fresh: false },
        value: { kind: 'personal', at: 1, titles: [] },
      }),
    ).toMatchObject({ ok: false });

    expect(
      decodeLibraryServiceServerMessage({
        type: 'update',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        subscriptionId: 'runtime',
        version,
        value: {
          kind: 'runtime',
          tmdbKey: 'key',
          providerKeys: { tmdb: 'key' },
          pluginManifestUrls: ['https://plugins.example/scout/manifest.json'],
          privateRemuxUrl: 'https://remux.tailnet.ts.net',
        },
      }),
    ).toMatchObject({ ok: true });
    expect(
      decodeLibraryServiceServerMessage({
        type: 'update',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        subscriptionId: 'runtime',
        version,
        value: {
          kind: 'runtime',
          tmdbKey: 'key',
          providerKeys: { tmdb: 'key' },
          pluginManifestUrls: [],
          privateRemuxUrl: null,
          otherApiKeys: { omdb: 'must-not-cross' },
        },
      }),
    ).toMatchObject({ ok: false });
  });

  it('rejects mismatched protocols and malformed domain values with typed failures', () => {
    expect(
      decodeLibraryServiceClientMessage({
        type: 'hello',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-invalid-key',
        clientId: 'tab-1',
        libraryKey: 'secret',
        mode: 'online',
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-request', retryable: false } });

    expect(
      decodeLibraryServiceClientMessage({
        type: 'hello',
        protocol: 99,
        requestId: 'request-1',
        clientId: 'tab-1',
        libraryKey,
        mode: 'online',
      }),
    ).toEqual({
      ok: false,
      error: {
        code: 'protocol-mismatch',
        message: 'library service protocol 99 is not supported',
        retryable: false,
        expectedProtocol: LIBRARY_SERVICE_PROTOCOL,
      },
    });

    expect(
      decodeLibraryServiceClientMessage({
        type: 'command',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-2',
        operationId: 'operation-1',
        command: {
          kind: 'progress.record',
          title: { type: 'movie', id: 42 },
          fraction: 1.5,
          seconds: -1,
          observedAt: 10,
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-request', retryable: false } });

    expect(
      decodeLibraryServiceClientMessage({
        type: 'command',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-3',
        operationId: 'operation-2',
        command: {
          kind: 'season-watched.set',
          title: { type: 'tv', id: 42 },
          season: 2,
          watched: true,
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-request' } });

    expect(
      decodeLibraryServiceClientMessage({
        type: 'command',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-4',
        operationId: 'operation-3',
        command: {
          kind: 'season-watched.set',
          title: { type: 'tv', id: 42 },
          season: 2,
          episodes: [1, 2, 2],
          watched: true,
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
  });

  it('rejects unknown storage fields and bounded-set violations at the wire boundary', () => {
    const subscribe = {
      type: 'subscribe',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId: 'request-strict',
      subscriptionId: 'visible-posters',
      selection: { kind: 'presence', titles: [{ type: 'movie', id: 12 }] },
    };

    expect(decodeLibraryServiceClientMessage({ ...subscribe, row: { kind: 'rec' } })).toMatchObject(
      {
        ok: false,
        error: { code: 'invalid-request' },
      },
    );
    expect(
      decodeLibraryServiceClientMessage({
        ...subscribe,
        selection: {
          kind: 'presence',
          titles: [{ type: 'movie', id: 12, row: { kind: 'rec' } }],
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
    expect(
      decodeLibraryServiceClientMessage({
        ...subscribe,
        selection: {
          kind: 'presence',
          titles: [
            { type: 'movie', id: 12 },
            { type: 'movie', id: 12 },
          ],
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
    expect(
      decodeLibraryServiceClientMessage({
        ...subscribe,
        selection: {
          kind: 'presence',
          titles: Array.from(
            { length: LIBRARY_SERVICE_WIRE_LIMITS.presenceTitles + 1 },
            (_, id) => ({ type: 'movie', id: id + 1 }),
          ),
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
    expect(
      decodeLibraryServiceClientMessage({
        type: 'hello',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-hello',
        clientId: 'tab-1',
        libraryKey,
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
    expect(
      decodeLibraryServiceClientMessage({
        type: 'command',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-season',
        operationId: 'operation-season',
        command: {
          kind: 'season-watched.set',
          title: { type: 'tv', id: 42 },
          season: 2,
          episodes: Array.from(
            { length: LIBRARY_SERVICE_WIRE_LIMITS.seasonEpisodes + 1 },
            (_, index) => index + 1,
          ),
          watched: true,
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
  });

  it('rejects ambiguous or malformed preference patches', () => {
    const decodePatch = (patch: unknown) =>
      decodeLibraryServiceClientMessage({
        type: 'command',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-preferences',
        operationId: 'operation-preferences',
        command: { kind: 'preferences.patch', patch },
      });

    expect(decodePatch({})).toMatchObject({ ok: false });
    expect(decodePatch({ excludedLanguages: ['fi', 'fi'] })).toMatchObject({ ok: false });
    expect(decodePatch({ audioLanguage: 'FIN' })).toMatchObject({ ok: false });
    expect(decodePatch({ ratingSources: [] })).toMatchObject({ ok: false });
    expect(
      decodePatch({ ratingSources: { kind: 'values', values: ['imdb', 'unknown'] } }),
    ).toMatchObject({ ok: false });
    expect(decodePatch({ services: { kind: 'default', values: [] } })).toMatchObject({ ok: false });
    expect(
      decodePatch({ services: { kind: 'values', values: [{ id: 8, country: 'fi' }] } }),
    ).toMatchObject({ ok: false });
    expect(decodePatch({ watchRegion: '' })).toMatchObject({ ok: false });
    expect(decodePatch({ rawSetting: { string: 'secret' } })).toMatchObject({ ok: false });
  });

  it('rejects duplicate and internally inconsistent title shapes', () => {
    const observe = (seasons: unknown[], lastAired?: unknown) =>
      decodeLibraryServiceClientMessage({
        type: 'observe',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-shape',
        observation: {
          kind: 'title-shape',
          title: { type: 'tv', id: 42 },
          seasons,
          ...(lastAired === undefined ? {} : { lastAired }),
        },
      });

    expect(
      observe([
        { season: 1, episodes: 8 },
        { season: 1, episodes: 9 },
      ]),
    ).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
    expect(observe([{ season: 2, episodes: 6 }], { season: 2, episode: 7 })).toMatchObject({
      ok: false,
      error: { code: 'invalid-request' },
    });
    expect(observe([{ season: 2, episodes: 6 }], { season: 3, episode: 1 })).toMatchObject({
      ok: false,
      error: { code: 'invalid-request' },
    });
    expect(
      observe(
        Array.from({ length: LIBRARY_SERVICE_WIRE_LIMITS.shapeSeasons + 1 }, (_, season) => ({
          season,
          episodes: 1,
        })),
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
  });
});

describe('library service server protocol', () => {
  it('accepts a versioned ready reply and immutable subscription replacement', () => {
    expect(
      decodeLibraryServiceServerMessage({
        type: 'ready',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-1',
        version,
      }),
    ).toMatchObject({ ok: true, value: { version } });

    expect(
      decodeLibraryServiceServerMessage({
        type: 'observed',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-4',
        version: { instance: 'worker-1', generation: null, revision: 0 },
      }),
    ).toMatchObject({ ok: true, value: { type: 'observed', version: { generation: null } } });

    expect(
      decodeLibraryServiceServerMessage({
        type: 'update',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        subscriptionId: 'continue',
        version: { ...version, revision: 15 },
        value: {
          kind: 'continue',
          items: [
            {
              title: { type: 'tv', id: 42 },
              episode: { season: 2, episode: 3 },
              fraction: 0.4,
              seconds: 812,
              updatedAt: 1_800_000_000_000,
            },
          ],
          needsShapes: [{ type: 'tv', id: 84 }],
        },
      }),
    ).toMatchObject({
      ok: true,
      value: { type: 'update', version: { revision: 15 }, value: { kind: 'continue' } },
    });

    expect(
      decodeLibraryServiceServerMessage({
        type: 'update',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        subscriptionId: 'history',
        version: { ...version, revision: 16 },
        value: {
          kind: 'history',
          items: [
            {
              title: { type: 'tv', id: 42 },
              watchedAt: 1_800_000_000_000,
              episode: { season: 2, episode: 3 },
              episodes: 11,
            },
          ],
        },
      }),
    ).toMatchObject({ ok: true, value: { value: { kind: 'history' } } });

    expect(
      decodeLibraryServiceServerMessage({
        type: 'update',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        subscriptionId: 'title-42',
        version: { ...version, revision: 16 },
        value: {
          kind: 'title',
          title: { type: 'tv', id: 42 },
          listed: false,
          watched: false,
          reaction: null,
          standing: 'in-progress',
          progress: null,
          episodes: [
            {
              season: 2,
              episode: 3,
              watched: false,
              fraction: 0.4,
              seconds: 812,
              updatedAt: 1_800_000_000_000,
            },
          ],
        },
      }),
    ).toMatchObject({ ok: true, value: { value: { kind: 'title', episodes: [{ episode: 3 }] } } });
  });

  it('validates typed service errors and rejects malformed replacements', () => {
    expect(
      decodeLibraryServiceServerMessage({
        type: 'error',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-1',
        error: { code: 'storage', message: 'journal unavailable', retryable: true },
      }),
    ).toMatchObject({ ok: true, value: { error: { code: 'storage', retryable: true } } });

    expect(
      decodeLibraryServiceServerMessage({
        type: 'update',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        subscriptionId: 'title',
        version,
        value: {
          kind: 'title',
          title: { type: 'movie', id: 9 },
          listed: 'yes',
          watched: false,
          reaction: null,
          standing: null,
          progress: null,
          episodes: [],
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-request' } });

    expect(
      decodeLibraryServiceServerMessage({
        type: 'update',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        subscriptionId: 'continue',
        version,
        value: { kind: 'continue', items: [], row: { kind: 'rec' } },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-request' } });

    expect(
      decodeLibraryServiceServerMessage({
        type: 'update',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        subscriptionId: 'history',
        version,
        value: {
          kind: 'history',
          items: [
            {
              title: { type: 'movie', id: 9 },
              watchedAt: 100,
              episodes: 0,
              stamp: [100, 0, 'device'],
            },
          ],
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
  });

  it('accepts complete preference views and rejects storage-shaped or inconsistent ones', () => {
    const preferences = {
      excludedGenres: [27],
      excludedLanguages: ['ja'],
      hideAnime: true,
      hideWatched: false,
      minReleaseYear: 2000,
      audioLanguage: 'fi',
      subtitleLanguage: 'en',
      shownSubtitleLanguages: ['en', 'sv'],
      subtitlesPerLanguage: 3,
      autoSkipSegments: true,
      autoplayTrailers: false,
      ratingSources: ['imdb', 'tmdb'],
      shownWarnings: ['Spoiler'],
      watchRegion: 'FI',
      services: [{ id: 8, country: 'FI' }],
      servicesConfigured: true,
      maturityCeiling: 'r',
    };
    const update = (value: unknown) =>
      decodeLibraryServiceServerMessage({
        type: 'update',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        subscriptionId: 'settings',
        version,
        value: { kind: 'settings', preferences: value },
      });

    expect(update(preferences)).toMatchObject({ ok: true });
    expect(update({ ...preferences, row: { kind: 'set', name: 'prefs' } })).toMatchObject({
      ok: false,
    });
    expect(update({ ...preferences, ratingSources: ['imdb', 'imdb'] })).toMatchObject({
      ok: false,
    });
    expect(
      update({ ...preferences, servicesConfigured: false, services: [{ id: 8, country: 'FI' }] }),
    ).toMatchObject({ ok: false });
    expect(update({ ...preferences, subtitlesPerLanguage: -1 })).toMatchObject({ ok: false });
  });

  it('accepts normalized connection views and bounded relay capabilities', () => {
    const connection = {
      kind: 'connections',
      apiKeys: { tmdb: { configured: true, masked: '••••cret' } },
      parentalPinConfigured: true,
      remoteAccessConfigured: false,
      plugins: [
        {
          manifestUrl: 'https://addon.example/manifest.json',
          signingKey: 'public-key',
          pendingApprovalOn: [{ id: 'abcdef0123456789', name: 'Apple TV' }],
        },
      ],
      servers: [{ kind: 'jellyfin', url: 'http://jellyfin.local:8096', user: 'u1' }],
      devices: [
        {
          id: 'abcdef0123456789',
          name: 'Apple TV',
          kind: 'tv',
          lastSeenAt: 100,
          libraryFormat: 3,
        },
      ],
      diagnostics: {
        libraryFormat: 4,
        pendingChanges: 1,
        selfDeviceId: '0123456789abcdef',
      },
    };
    const update = (value: unknown) =>
      decodeLibraryServiceServerMessage({
        type: 'update',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        subscriptionId: 'connections',
        version,
        value,
      });
    expect(update(connection)).toMatchObject({ ok: true });
    expect(update({ ...connection, row: { kind: 'set', name: 'keys' } })).toMatchObject({
      ok: false,
    });
    expect(
      update({
        ...connection,
        devices: [{ ...connection.devices[0], stamp: [1, 0, 'device'] }],
      }),
    ).toMatchObject({ ok: false });

    const membership = (capability: unknown) =>
      decodeLibraryServiceServerMessage({
        type: 'query-result',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'relay',
        version,
        result: { kind: 'relay.membership', capability },
      });
    expect(membership({ libraryId: 'a'.repeat(32), memberToken: 'b'.repeat(64) })).toMatchObject({
      ok: true,
    });
    expect(
      membership({
        libraryId: 'a'.repeat(32),
        memberToken: 'b'.repeat(64),
        libraryKey: 'must-not-cross',
      }),
    ).toMatchObject({ ok: false });
  });

  it('keeps download sources semantic and rejects provider tickets at the wire boundary', () => {
    const result = (source: Record<string, unknown>) =>
      decodeLibraryServiceServerMessage({
        type: 'query-result',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'download-sources',
        version,
        result: {
          kind: 'download.sources',
          sources: [
            {
              identity: 'release-one',
              label: 'Release One',
              filename: 'release-one.mkv',
              badges: ['4K'],
              languages: ['en'],
              probed: true,
              ...source,
            },
          ],
          answer: { kind: 'partial', missing: 1 },
        },
      });
    expect(result({ cached: true, seeders: 2 })).toMatchObject({ ok: true });
    expect(result({ url: '/scout/p/private-ticket' })).toMatchObject({ ok: false });
    expect(result({ attributes: { provider: 'private' } })).toMatchObject({ ok: false });

    expect(
      decodeLibraryServiceClientMessage({
        type: 'query',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'download-artwork',
        query: {
          kind: 'download.artwork',
          target: { type: 'tv', id: 7, season: 2, episode: 3 },
        },
      }),
    ).toMatchObject({ ok: true });
  });

  it('carries delivery, resolved playback intent, and session status without storage details', () => {
    expect(
      decodeLibraryServiceServerMessage({
        type: 'command-result',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-6',
        operationId: 'operation-6',
        outcome: 'applied',
        delivery: 'queued',
        version,
      }),
    ).toMatchObject({ ok: true, value: { delivery: 'queued', version } });

    expect(
      decodeLibraryServiceServerMessage({
        type: 'query-result',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-7',
        version,
        result: {
          kind: 'playback.prepare',
          action: 'next',
          target: { type: 'tv', id: 42, season: 2, episode: 4 },
          resume: null,
        },
      }),
    ).toMatchObject({
      ok: true,
      value: { result: { action: 'next', target: { episode: 4 }, resume: null } },
    });

    for (const status of [
      { kind: 'ready', version },
      { kind: 'reconnecting', version },
      { kind: 'read-only', version, reason: 'library format is newer' },
      { kind: 'moved', successor: 'successor-library' },
      {
        kind: 'failed',
        error: { code: 'storage', message: 'journal unavailable', retryable: true },
      },
    ]) {
      expect(
        decodeLibraryServiceServerMessage({
          type: 'status',
          protocol: LIBRARY_SERVICE_PROTOCOL,
          status,
        }),
      ).toMatchObject({ ok: true, value: { type: 'status' } });
    }
  });
});
