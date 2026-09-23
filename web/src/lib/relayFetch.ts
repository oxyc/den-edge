// Proof that this browser holds a library here, sent with the addon calls that go through den-edge's relay.
//
// The relay budgets requests per address: a visitor gets enough to read pages, a member enough to browse
// properly. Membership is claimed with `x-den-library-member: <id>:<member>`, and until this existed the web
// app never sent it — so a paired household was charged the visitor's budget and refused part-way through
// rendering its own home page, with the billboard trailers stopping mid-render.
//
// ONLY the relayed prefixes get the header, and only same-origin. The token opens this library to anyone
// holding it, so attaching it to every request would hand it to api.themoviedb.org, omdbapi.com and whatever
// else a page happens to call. The allow-list is the security boundary here, not an optimisation.

import type { LibraryKeys } from './wire';

/**
 * The paths den-edge relays to the addons (`ADDON_RELAY`), and the same-origin APIs where membership changes
 * the allowance or permits spending a household key. Anything else is somebody else's server.
 */
const RELAYED = ['/scout/', '/atlas/', '/reel/', '/warnings/', '/ratings/', '/metadata/', '/tmdb/'];
const REMUX_CONTROL = new Set([
  '/remux/health',
  '/remux/session',
  '/remux/releases',
  '/remux/speed',
]);
const MEMBER_HEADER = 'x-den-library-member';
/** A shared library's own credential (`x-den-grant: <gid>:<secret>`): a guest is never a member. */
const GRANT_HEADER = 'x-den-grant';
/** `/<addon>/~<gid>/…`: an addon shared through a grant, which is asked with the grant and never the library. */
const GRANT_BASE = /^\/(?:scout|atlas|reel|subtitles)\/~([0-9a-f]{8})(?:\/|$)/;
/** The install a session body names, `<origin>/scout/~<gid>`. */
const GRANT_INSTALL = /\/(?:scout|subtitles)\/~([0-9a-f]{8})\/?$/;
/** The host's own grant routes, which prove membership of the library in the path. */
const HOST_GRANTS = /^\/lib\/([0-9a-f]+)\/grants(?:\/|$)/;

let credential: string | null = null;
let libraryId: string | null = null;
/** The secrets of the grants this browser holds, by grant id. Never leaves this module except in the header. */
const grantSecrets = new Map<string, string>();
let grantEnded: ((gid: string) => void) | null = null;

/** The open library's id, which its host routes carry in the path; null for a visitor. */
export function libraryCredentialId(): string | null {
  return libraryId;
}

/** Remember a grant's secret, so calls to its `~<gid>` addons can carry it. */
export function rememberGrant(gid: string, secret: string): void {
  grantSecrets.set(gid, secret);
}

/** Forget a grant's secret: it ended, or this browser left it. */
export function forgetGrant(gid: string): void {
  grantSecrets.delete(gid);
}

/** Told when den-edge answers a grant's call with `grant_expired`, so the page can say the access ended. */
export function onGrantEnded(listener: ((gid: string) => void) | null): void {
  grantEnded = listener;
}

/** Whether this browser can authenticate a shared-cache write, without exposing the credential itself. */
export function hasLibraryCredential(): boolean {
  return credential !== null;
}

/** Remember the open library's credential, so relayed calls can prove membership. */
export function useLibraryCredential(keys: Pick<LibraryKeys, 'id' | 'member'>): void {
  credential = `${keys.id}:${keys.member}`;
  libraryId = keys.id;
}

/** Forget it — an unlinked browser is a visitor again, and must stop claiming otherwise. */
export function forgetLibraryCredential(): void {
  credential = null;
  libraryId = null;
}

/**
 * The same claim, on hls.js's own requests.
 *
 * hls.js issues XHRs of its own, so `relayFetch` never sees them — and those are exactly the relayed
 * calls a member must not be counted as a guest for, since the media relay budgets guests apart. The
 * credential stays in this module and the allow-list still decides: another host's URL gets nothing.
 */
export function memberXhrSetup(xhr: XMLHttpRequest, url: string): void {
  if (credential && relayed(url)) xhr.setRequestHeader(MEMBER_HEADER, credential);
}

/** `href` as a URL when it is on this page's origin; null for anyone else's, or with no page to compare against. */
function ours(href: string): URL | null {
  // With no page to compare against there is no telling our origin from anyone else's, and a path is not
  // enough on its own: `https://elsewhere.example/scout/…` has the same one. The safe answer is "not ours".
  const here = globalThis.location?.href;
  if (!here) return null;
  try {
    const url = new URL(href, here);
    return url.origin === new URL(here).origin ? url : null;
  } catch {
    // An unparseable URL is not one of ours.
    return null;
  }
}

function relayed(href: string): boolean {
  const url = ours(href);
  return (
    !!url &&
    (RELAYED.some((p) => url.pathname.startsWith(p)) ||
      REMUX_CONTROL.has(url.pathname) ||
      (libraryId !== null && HOST_GRANTS.exec(url.pathname)?.[1] === libraryId))
  );
}

/**
 * The grant a call belongs to, when it is one a guest makes: to a shared addon's `~<gid>` base, or to the
 * `/remux` control relay for a session whose body names a shared install. With no member credential the
 * relay's health probe has nothing else to claim, so it takes a held grant.
 */
function grantOf(url: URL, init: RequestInit | undefined): string | null {
  const shared = GRANT_BASE.exec(url.pathname)?.[1];
  if (shared) return shared;
  if (!REMUX_CONTROL.has(url.pathname)) return null;
  if (typeof init?.body === 'string') {
    try {
      const install = (JSON.parse(init.body) as { scout?: unknown }).scout;
      const gid = typeof install === 'string' ? GRANT_INSTALL.exec(install)?.[1] : undefined;
      if (gid && grantSecrets.has(gid)) return gid;
    } catch {
      // Not JSON: nothing names a grant.
    }
  }
  return credential ? null : (grantSecrets.keys().next().value ?? null);
}

/** A call carrying the grant's credential, and never the library's: a guest is not a member. */
async function guestFetch(
  gid: string,
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
): Promise<Response> {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.delete(MEMBER_HEADER);
  const secret = grantSecrets.get(gid);
  if (secret) headers.set(GRANT_HEADER, `${gid}:${secret}`);
  const res = await fetch(input, { ...init, headers });
  if (res.status === 410) {
    const expired = await res
      .clone()
      .json()
      .then((body: { error?: unknown } | null) => body?.error === 'grant_expired')
      .catch(() => false);
    if (expired) grantEnded?.(gid);
  }
  return res;
}

/**
 * `fetch`, with the membership claim attached to relayed addon calls and to nothing else — and a shared
 * addon's grant credential attached to that addon's `~<gid>` calls, in place of the claim.
 *
 * Safe as a default everywhere: with no library open, or for any other host, it is exactly `fetch`.
 */
export const relayFetch: typeof fetch = (input, init) => {
  const href =
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const url = ours(href);
  const gid = url && grantOf(url, init);
  if (gid) return guestFetch(gid, input, init);
  if (!credential || !relayed(href)) return fetch(input, init);
  const inherited = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  const headers = new Headers(inherited);
  headers.set(MEMBER_HEADER, credential);
  return fetch(input, { ...init, headers });
};
