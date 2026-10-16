import { privateLanHost, privateLanRemuxPlaylist } from '../../src/lib/localNetwork';

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
      ((parsed.protocol === 'https:' && mediaHost(parsed.hostname)) ||
        (parsed.protocol === 'http:' && privateLanHost(parsed.hostname))) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash &&
      !parsed.search &&
      PLAYLIST.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/** A signed playlist explicitly confined to a receiver-reachable private LAN host. */
export function lanHttpMedia(url: string): boolean {
  return privateLanRemuxPlaylist(url) && signedMedia(url);
}

/** A TorBox-managed HLS capability. Its query explicitly disables provider scrobbling before it may leave Den. */
export function managedMedia(url: string): boolean {
  try {
    const parsed = new URL(url);
    const scrobbling = parsed.searchParams.getAll('scrobbling_enabled');
    return (
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port &&
      parsed.hostname.endsWith('.tb-cdn.io') &&
      parsed.hostname.length > '.tb-cdn.io'.length &&
      parsed.pathname !== '/' &&
      !parsed.hash &&
      scrobbling.length === 1 &&
      scrobbling[0] === 'false'
    );
  } catch {
    return false;
  }
}

/** The exact load whose lifecycle the Cast page owns, independent of a newer load still being prepared. */
export interface PlayingMedia {
  url: string;
  external: boolean;
  /** HTTPS control capability when the receiver uses the same session through its LAN HTTP media alias. */
  lifecycleUrl?: string;
}

/** Only a Remux load has Den report/end operations. A managed CDN URL must never receive either request. */
export function denLifecycleMedia(playing: PlayingMedia | undefined): string | null {
  // An HTTPS sender does not fetch a private HTTP media capability. The parent page already reached the local
  // Remux control plane and owns this session's heartbeat, report, and end requests.
  if (!playing || playing.external) return null;
  if (playing.lifecycleUrl && signedMedia(playing.lifecycleUrl)) return playing.lifecycleUrl;
  return !lanHttpMedia(playing.url) ? playing.url : null;
}
