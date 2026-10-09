import { expect, it } from 'vitest';
import { ContentServiceClient, type ContentServiceTransport } from './contentServiceClient';
import { ContentServiceCore } from './contentServiceCore';
import {
  CONTENT_SERVICE_PROTOCOL,
  type ContentRequest,
  type ContentResult,
  type ContentServiceClientMessage,
  type ContentServiceServerMessage,
} from './contentServiceProtocol';
import {
  decodeContentServiceClientMessage,
  decodeContentServiceServerMessage,
} from './contentServiceProtocolCodec';

class FakeTransport implements ContentServiceTransport {
  sent: ContentServiceClientMessage[] = [];
  listener?: (message: unknown) => void;

  send(message: ContentServiceClientMessage): void {
    this.sent.push(message);
  }

  listen(listener: (message: unknown) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  close(): void {}

  receive(message: ContentServiceServerMessage): void {
    this.listener?.(message);
  }
}

it('validates bounded semantic requests and unversioned content replies', () => {
  expect(
    decodeContentServiceClientMessage({
      type: 'content-query',
      protocol: CONTENT_SERVICE_PROTOCOL,
      requestId: 'one',
      request: {
        kind: 'catalog.page',
        catalog: { kind: 'recommendations', title: { type: 'movie', id: 7 } },
        page: 1,
      },
    }).ok,
  ).toBe(true);
  expect(
    decodeContentServiceClientMessage({
      type: 'content-query',
      protocol: CONTENT_SERVICE_PROTOCOL,
      requestId: 'too-deep',
      request: {
        kind: 'catalog.page',
        catalog: { kind: 'popular', media: 'movie' },
        page: 501,
      },
    }).ok,
  ).toBe(false);
  const reply = {
    type: 'content-result',
    protocol: CONTENT_SERVICE_PROTOCOL,
    requestId: 'one',
    result: { kind: 'service.regions', regions: [] },
  };
  expect(decodeContentServiceServerMessage(reply)).toEqual({ ok: true, value: reply });
  expect(decodeContentServiceServerMessage({ ...reply, version: { revision: 1 } }).ok).toBe(false);
});

it('cancels the page waiter immediately and ignores its late Worker result', async () => {
  const transport = new FakeTransport();
  const client = new ContentServiceClient(transport, 'page');
  const controller = new AbortController();
  const pending = client.query(
    { kind: 'prefetch.detail', title: { type: 'movie', id: 7 }, region: 'US' },
    controller.signal,
  );
  const query = transport.sent[0];
  expect(query).toMatchObject({ type: 'content-query', requestId: 'page:content:1' });

  controller.abort();
  await expect(pending).rejects.toMatchObject({ failure: { code: 'cancelled' } });
  expect(transport.sent[1]).toEqual({
    type: 'content-cancel',
    protocol: CONTENT_SERVICE_PROTOCOL,
    targetRequestId: 'page:content:1',
  });
  transport.receive({
    type: 'content-result',
    protocol: CONTENT_SERVICE_PROTOCOL,
    requestId: 'page:content:1',
    result: { kind: 'prefetch.detail' },
  });
  client.close();
});

it('runs independent reads concurrently and aborts only the requested operation', async () => {
  const releases = new Map<string, (result: ContentResult) => void>();
  const signals = new Map<string, AbortSignal>();
  const core = new ContentServiceCore({
    query(request: ContentRequest, signal: AbortSignal) {
      signals.set(request.kind, signal);
      return new Promise<ContentResult>((resolve) => releases.set(request.kind, resolve));
    },
  });
  const first = core.dispatch({
    type: 'content-query',
    protocol: CONTENT_SERVICE_PROTOCOL,
    requestId: 'regions',
    request: { kind: 'service.regions' },
  });
  const second = core.dispatch({
    type: 'content-query',
    protocol: CONTENT_SERVICE_PROTOCOL,
    requestId: 'prefetch',
    request: {
      kind: 'prefetch.detail',
      title: { type: 'movie', id: 7 },
      region: 'US',
    },
  });
  await core.dispatch({
    type: 'content-cancel',
    protocol: CONTENT_SERVICE_PROTOCOL,
    targetRequestId: 'prefetch',
  });
  expect(signals.get('prefetch.detail')?.aborted).toBe(true);
  expect(signals.get('service.regions')?.aborted).toBe(false);

  releases.get('prefetch.detail')?.({ kind: 'prefetch.detail' });
  releases.get('service.regions')?.({ kind: 'service.regions', regions: [] });
  await expect(first).resolves.toMatchObject([{ type: 'content-result', requestId: 'regions' }]);
  await expect(second).resolves.toMatchObject([
    { type: 'content-error', requestId: 'prefetch', error: { code: 'cancelled' } },
  ]);
  await core.close();
});
