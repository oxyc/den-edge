import type { ActiveProfileMode } from './profileModeCoordinator.svelte';

export interface ProfileSwitcherRequest {
  readonly trigger: HTMLElement;
  readonly restoreFocus: boolean;
  /** Open directly at the named profile's authorization step instead of the general chooser. */
  readonly target?: ActiveProfileMode;
  /** Continue here only after that profile transition commits. */
  readonly successPath?: string;
}

const EVENT = 'den:open-profile-switcher';

/** Open the one app-level switcher from another surface, such as mobile Settings. */
export function openProfileSwitcher(request: ProfileSwitcherRequest): void {
  window.dispatchEvent(new CustomEvent<ProfileSwitcherRequest>(EVENT, { detail: request }));
}

export function onProfileSwitcherRequest(
  listener: (request: ProfileSwitcherRequest) => void,
): () => void {
  const receive = (event: Event) => listener((event as CustomEvent<ProfileSwitcherRequest>).detail);
  window.addEventListener(EVENT, receive);
  return () => window.removeEventListener(EVENT, receive);
}
