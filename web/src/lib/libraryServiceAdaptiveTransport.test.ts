import { expect, it, vi } from 'vitest';
import { AdaptiveLibraryServiceTransport } from './libraryServiceAdaptiveTransport';
import type { LibraryServiceMultiplexTransport } from './libraryServiceMultiplexTransport';
import { CONTENT_SERVICE_PROTOCOL } from './contentServiceProtocol';

const fakeTransport = (): LibraryServiceMultiplexTransport & { sent: unknown[] } => {
  const sent: unknown[] = [];
  return {
    sent,
    send: (message) => sent.push(message),
    listen: () => () => {},
    contentTransport: () => ({
      send: (message) => sent.push(message),
      listen: () => () => {},
      close() {},
    }),
    close() {},
  };
};

it('does not start the heavy dedicated fallback for configuration that precedes a library hello', () => {
  const dedicated = vi.fn(fakeTransport);
  const transport = new AdaptiveLibraryServiceTransport(dedicated);
  transport.send({
    type: 'content-query',
    protocol: CONTENT_SERVICE_PROTOCOL,
    requestId: 'grants',
    request: { kind: 'grants.configure', grants: [] },
  });

  expect(dedicated).not.toHaveBeenCalled();
  transport.close();
});

it('starts the dedicated fallback lazily for a public session with no library hello', async () => {
  const fallback = fakeTransport();
  const dedicated = vi.fn(() => fallback);
  const transport = new AdaptiveLibraryServiceTransport(dedicated);
  transport.send({
    type: 'content-query',
    protocol: CONTENT_SERVICE_PROTOCOL,
    requestId: 'regions',
    request: { kind: 'service.regions' },
  });
  await Promise.resolve();

  expect(dedicated).toHaveBeenCalledOnce();
  expect(fallback.sent).toHaveLength(1);
  transport.close();
});
