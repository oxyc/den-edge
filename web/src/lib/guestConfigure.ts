import { libraryConfigureClaim } from './relayFetch';

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

export interface ConfigureSubmission {
  action: string;
  target: '_blank';
  fields: Record<string, string>;
}

function submitNative({ action, target, fields }: ConfigureSubmission): void {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = action;
  form.target = target;
  form.rel = 'noopener';
  form.hidden = true;
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  try {
    form.submit();
  } finally {
    form.remove();
  }
}

/** Open Hearth through a native POST so mobile browsers keep the user-requested new tab. */
export function openGuestConfigure(
  gid: string,
  secret: string,
  deps: {
    submitImpl?: (submission: ConfigureSubmission) => void;
  } = {},
): boolean {
  if (!/^[0-9a-f]{8}$/.test(gid) || !secret) return false;
  try {
    (deps.submitImpl ?? submitNative)({
      action: '/grant/den-configure',
      target: '_blank',
      fields: { grant: `${gid}:${secret}` },
    });
    return true;
  } catch {
    return false;
  }
}

/** Open the owner's real Hearth setup page through the same browser-native new-tab POST. */
export function openOwnerConfigure(
  configureURL: string,
  deps: {
    claimImpl?: () => string | null;
    submitImpl?: (submission: ConfigureSubmission) => void;
  } = {},
): boolean {
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
  const claim = (deps.claimImpl ?? libraryConfigureClaim)();
  if (!claim) return false;
  try {
    (deps.submitImpl ?? submitNative)({
      action: '/grant/den-configure',
      target: '_blank',
      fields: { member: claim },
    });
    return true;
  } catch {
    return false;
  }
}
