import type { LibraryObservation, LibraryServiceHello } from './libraryServiceProtocol';

type Lifecycle = Extract<LibraryObservation, { kind: 'lifecycle' }>;

export function aggregateLibraryLifecycles(states: readonly Lifecycle[]): Lifecycle {
  const visible = states.filter((state) => state.visible);
  return {
    kind: 'lifecycle',
    visible: visible.length > 0,
    online: states.some((state) => state.online),
    playbackActive: states.some((state) => state.playbackActive),
    // Maintenance waits only while every tab on screen is a player: another tab still being browsed needs it.
    playerOpen: visible.length > 0 && visible.every((state) => state.playerOpen),
  };
}

/** Durable clock is migration input, not authority identity. The script URL fences releases. */
export function sharedLibraryIdentity(
  workerUrl: string,
  hello: LibraryServiceHello | Pick<LibraryServiceHello, 'libraryKey' | 'mode' | 'wire'>,
): string {
  return `${workerUrl}\n${JSON.stringify([hello.libraryKey, hello.mode, hello.wire])}`;
}
