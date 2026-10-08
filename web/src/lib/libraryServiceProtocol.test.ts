import { describe, expect, it } from 'vitest';
import {
  decodeLibraryServiceClientMessage,
  decodeLibraryServiceServerMessage,
} from './libraryServiceProtocolCodec';
import { LIBRARY_SERVICE_PROTOCOL, LIBRARY_SERVICE_WIRE_LIMITS } from './libraryServiceProtocol';

const version = { instance: 'worker-1', generation: 'generation-3', revision: 14 };

describe('library service client protocol', () => {
  it('accepts a handshake and semantic, idempotent commands', () => {
    expect(
      decodeLibraryServiceClientMessage({
        type: 'hello',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-1',
        clientId: 'tab-1',
        libraryKey: 'secret',
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
  });

  it('rejects mismatched protocols and malformed domain values with typed failures', () => {
    expect(
      decodeLibraryServiceClientMessage({
        type: 'hello',
        protocol: 99,
        requestId: 'request-1',
        clientId: 'tab-1',
        libraryKey: 'secret',
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
        libraryKey: 'secret',
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
