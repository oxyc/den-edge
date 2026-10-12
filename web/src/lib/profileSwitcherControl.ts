export interface ProfileSwitcherRequest {
  readonly trigger: HTMLElement;
  readonly restoreFocus: boolean;
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
