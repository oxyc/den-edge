import { describe, expect, it } from 'vitest';
import {
  decodeLibraryServiceClientMessage,
  decodeLibraryServiceServerMessage,
} from './libraryServiceProtocolCodec';
import { LIBRARY_SERVICE_PROTOCOL } from './libraryServiceProtocol';

const version = { instance: 'worker-1', generation: 3, revision: 14 };

describe('library service client protocol', () => {
  it('accepts a handshake and semantic, idempotent commands', () => {
    expect(
      decodeLibraryServiceClientMessage({
        type: 'hello',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-1',
        clientId: 'tab-1',
        libraryKey: 'secret',
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

  it('rejects mismatched protocols and malformed domain values with typed failures', () => {
    expect(
      decodeLibraryServiceClientMessage({
        type: 'hello',
        protocol: 99,
        requestId: 'request-1',
        clientId: 'tab-1',
        libraryKey: 'secret',
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
        },
      }),
    ).toMatchObject({
      ok: true,
      value: { type: 'update', version: { revision: 15 }, value: { kind: 'continue' } },
    });
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
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
  });
});
