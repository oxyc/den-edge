import type { LibraryObservation, LibraryServiceHello } from './libraryServiceProtocol';

type Lifecycle = Extract<LibraryObservation, { kind: 'lifecycle' }>;

export function aggregateLibraryLifecycles(states: readonly Lifecycle[]): Lifecycle {
  return {
    kind: 'lifecycle',
    visible: states.some((state) => state.visible),
    online: states.some((state) => state.online),
    playbackActive: states.some((state) => state.playbackActive),
  };
}

/** Durable clock is migration input, not authority identity. The script URL fences releases. */
export function sharedLibraryIdentity(workerUrl: string, hello: LibraryServiceHello): string {
  return `${workerUrl}\n${JSON.stringify([hello.libraryKey, hello.mode, hello.wire])}`;
}
