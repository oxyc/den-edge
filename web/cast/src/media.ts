const PLAYLIST = /^\/remux\/s\/[A-Za-z0-9_-]{22}\/[A-Za-z0-9_-]{22}\/master\.m3u8$/;

/** An IP literal, or a label under one of the media `domains` (a wildcard-certified zone holding only that record). */
function mediaHost(host: string, domains: readonly string[]): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) return true;
  return domains.some((domain) => host.endsWith(`.${domain}`));
}

/** A signed den-remux playlist on the public listener: https, on an address or a media-domain name Den handed over. */
export function signedMedia(url: string, domains: readonly string[] = []): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      mediaHost(parsed.hostname, domains) &&
      PLAYLIST.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}
