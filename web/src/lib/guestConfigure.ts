const REVOKE_AFTER_MS = 60_000;

/** Open Edge's grant-adapted combined-Den setup page without putting the grant secret in a URL or storage. */
export async function openGuestConfigure(
  gid: string,
  secret: string,
  deps: {
    fetchImpl?: typeof fetch;
    openImpl?: (url: string, target: string) => Window | null;
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
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
    response = await fetchImpl(`/den/~${gid}/configure`, {
      headers: { 'x-den-grant': `${gid}:${secret}` },
      cache: 'no-store',
    });
  } catch {
    response = null;
  }
  if (!response?.ok || !response.headers.get('content-type')?.startsWith('text/html')) {
    opened.close();
    return false;
  }
  const html = await response.text().catch(() => null);
  if (html === null) {
    opened.close();
    return false;
  }
  const create = deps.createObjectURL ?? URL.createObjectURL.bind(URL);
  const revoke = deps.revokeObjectURL ?? URL.revokeObjectURL.bind(URL);
  let blobUrl: string | undefined;
  try {
    blobUrl = create(new Blob([html], { type: 'text/html' }));
    opened.location.replace(blobUrl);
  } catch {
    if (blobUrl) revoke(blobUrl);
    opened.close();
    return false;
  }
  setTimeout(() => revoke(blobUrl), REVOKE_AFTER_MS);
  return true;
}
