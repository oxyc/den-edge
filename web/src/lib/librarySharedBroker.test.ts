import { expect, it } from 'vitest';
import { aggregateLibraryLifecycles, sharedLibraryIdentity } from './librarySharedBroker';
import { LIBRARY_SERVICE_PROTOCOL, type LibraryServiceHello } from './libraryServiceProtocol';

it('keeps shared maintenance active while any attached tab needs it', () => {
  expect(
    aggregateLibraryLifecycles([
      { kind: 'lifecycle', visible: false, online: true, playbackActive: false },
      { kind: 'lifecycle', visible: true, online: false, playbackActive: true },
    ]),
  ).toEqual({ kind: 'lifecycle', visible: true, online: true, playbackActive: true });
});

it('shares evolving legacy clock seeds but fences a different release URL', () => {
  const hello: LibraryServiceHello = {
    type: 'hello',
    protocol: LIBRARY_SERVICE_PROTOCOL,
    requestId: 'open',
    clientId: 'tab',
    libraryKey: 'key',
    mode: 'online',
    wire: 4,
    legacyClock: { device: 'one', last: [1, 1, 'one'] },
  };
  const first = sharedLibraryIdentity('/assets/shared-aaa.js', hello);
  expect(
    sharedLibraryIdentity('/assets/shared-aaa.js', {
      ...hello,
      legacyClock: { device: 'two', last: [2, 99, 'two'] },
    }),
  ).toBe(first);
  expect(sharedLibraryIdentity('/assets/shared-bbb.js', hello)).not.toBe(first);
});
