import { relayFetch } from './relayFetch';

const SHARED_MEDIA = ['scout', 'subtitles', 'reel'] as const;

/** Whether clearing a personal Hearth install leaves this guest with shared media services. */
export function hasSharedMediaSettings(addons: Partial<Record<string, string>>): boolean {
  return SHARED_MEDIA.some((addon) => typeof addons[addon] === 'string');
}

/** Clear only this guest's personal Hearth config. The stable grant and its shared addons remain. */
export async function clearGuestConfigure(
  gid: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!/^[0-9a-f]{8}$/.test(gid) || !secret) return false;
  try {
    const response = await fetchImpl('/grant/den-install', {
      method: 'DELETE',
      headers: { 'x-den-grant': `${gid}:${secret}` },
      cache: 'no-store',
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Open Hearth's real setup page after establishing its short-lived, HttpOnly guest setup session. */
export async function openGuestConfigure(
  gid: string,
  secret: string,
  deps: {
    fetchImpl?: typeof fetch;
    openImpl?: (url: string, target: string) => Window | null;
  } = {},
): Promise<boolean> {
  if (!/^[0-9a-f]{8}$/.test(gid) || !secret) return false;
  // Reserve the tab while still in the click event; opening only after the fetch would be pop-up blocked.
  const opened = (deps.openImpl ?? window.open.bind(window))('', '_blank');
  if (!opened) return false;
  opened.opener = null;
  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response | null;
  try {
    response = await fetchImpl('/grant/den-configure', {
      method: 'POST',
      headers: { 'x-den-grant': `${gid}:${secret}` },
      cache: 'no-store',
    });
  } catch {
    response = null;
  }
  if (!response?.ok) {
    opened.close();
    return false;
  }
  try {
    opened.location.replace(`/den/~${gid}/configure`);
  } catch {
    opened.close();
    return false;
  }
  return true;
}

/** Open the owner's real Hearth setup page after establishing its narrow HttpOnly member session. */
export async function openOwnerConfigure(
  configureURL: string,
  deps: {
    fetchImpl?: typeof fetch;
    openImpl?: (url: string, target: string) => Window | null;
  } = {},
): Promise<boolean> {
  let destination: URL;
  try {
    destination = new URL(
      configureURL,
      configureURL.startsWith('/') ? 'https://den.invalid' : undefined,
    );
  } catch {
    return false;
  }
  if (!/^\/den\/configure\/?$/.test(destination.pathname)) return false;
  const opened = (deps.openImpl ?? window.open.bind(window))('', '_blank');
  if (!opened) return false;
  opened.opener = null;
  let response: Response | null;
  try {
    response = await (deps.fetchImpl ?? relayFetch)('/grant/den-configure', {
      method: 'POST',
      cache: 'no-store',
    });
  } catch {
    response = null;
  }
  if (!response?.ok) {
    opened.close();
    return false;
  }
  try {
    opened.location.replace(configureURL);
  } catch {
    opened.close();
    return false;
  }
  return true;
}
