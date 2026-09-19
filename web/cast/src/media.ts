const PLAYLIST = /^\/remux\/s\/[A-Za-z0-9_-]{22}\/[A-Za-z0-9_-]{22}\/master\.m3u8$/;
const DNS_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/;

/** An IP literal, or a dotted DNS name. No zone is named here: the sender is public, and the parent origin is checked. */
function mediaHost(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':') || DNS_NAME.test(host);
}

/** A signed den-remux playlist on the public listener: https, on an address or a name Den's session handed over. */
export function signedMedia(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' && mediaHost(parsed.hostname) && PLAYLIST.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}
