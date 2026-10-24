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
import { apiOrigin, serviceOrigin } from './runtimeUrl';

/**
 * The least authority a page needs to receive the household relay allowance. This is derived from the library key
 * inside LibraryService; it can authenticate only the allow-listed relay paths below and cannot open the library.
 */
export interface LibraryRelayMembership {
  libraryId: string;
  memberToken: string;
}

/**
 * The paths den-edge relays to the addons (`ADDON_RELAY`), and the same-origin APIs where membership changes
 * the allowance or permits spending a household key. Anything else is somebody else's server.
 */
const RELAYED = [
  '/scout/',
  '/den/',
  '/atlas/',
  '/reel/',
  '/warnings/',
  '/ratings/',
  '/metadata/',
  '/tmdb/',
];
const REMUX_CONTROL = new Set([
  '/remux/health',
  '/remux/session',
  '/remux/releases',
  '/remux/speed',
  '/remux/grant',
]);
function remuxControl(path: string): boolean {
  return (
    REMUX_CONTROL.has(path) ||
    /^\/remux\/s\/[A-Za-z0-9_-]{22}\/[A-Za-z0-9_-]{22}\/(?:subtitle-resync|sub[0-9]+\.aligned\.vtt)$/.test(
      path,
    )
  );
}
const MEMBER_HEADER = 'x-den-library-member';
/** A shared library's own credential (`x-den-grant: <gid>:<secret>`): a guest is never a member. */
const GRANT_HEADER = 'x-den-grant';
/** `/<addon>/~<gid>/…`: an addon shared through a grant, which is asked with the grant and never the library. */
const GRANT_BASE = /^\/(?:scout|den|atlas|reel|subtitles)\/~([0-9a-f]{8})(?:\/|$)/;
/** The install a session body names, `<origin>/scout/~<gid>`. */
const GRANT_INSTALL = /\/(?:scout|den|subtitles)\/~([0-9a-f]{8})\/?$/;
/** The host's own grant routes, which prove membership of the library in the path. */
const HOST_GRANTS = /^\/lib\/([0-9a-f]+)\/grants(?:\/|$)/;
/**
 * The assistant connector's routes that ask who this browser is (`oauth.rs`): approving a connection, and listing or
 * ending them. A member proves membership; a guest, with no library of their own, proves their grant.
 */
const OAUTH = /^\/oauth\/(?:request\/[0-9a-f]{32}\/approve|connections(?:\/[0-9a-f]{32})?)$/;
/** Assistant writes' member routes (`assistant.rs`): the drop-box key, and draining and acknowledging the queue. */
const ASSISTANT = /^\/assistant\/(?:dropbox|drain|ack)$/;
/** Establishes a short-lived HttpOnly session for the owner's real Hearth setup document. */
const DEN_CONFIGURE_SESSION = '/grant/den-configure';

let credential: string | null = null;
let libraryId: string | null = null;
/** Counts every change of the credential, so a refusal of one can be told from the next (`credentialVersion`). */
let version = 0;
/**
 * A paired library hello which has started but has not installed its bounded membership yet. Page-owned relay
 * consumers share this barrier with the Worker bootstrap: none may escape as an anonymous visitor merely because
 * its component mounted before the encrypted library finished opening.
 */
let membershipOpening: { ready: Promise<void>; token: symbol } | null = null;
/**
 * The secrets of the grants this browser holds, by grant id. Leaves this module only in the header, and from the page
 * to the library Worker (`onHeldGrants`), whose own copy of this module makes the content calls.
 */
const grantSecrets = new Map<string, string>();
let grantEnded: ((gid: string) => void) | null = null;
const heldGrantListeners = new Set<(grants: HeldGrant[]) => void>();
/** The grants a `~<gid>` call was refused for want of a secret, so each is warned about once. */
const unheldWarned = new Set<string>();

/** A grant's id and secret, as the page hands them to the library Worker. */
export interface HeldGrant {
  gid: string;
  secret: string;
}

function heldGrants(): HeldGrant[] {
  return [...grantSecrets].map(([gid, secret]) => ({ gid, secret }));
}

function grantsChanged(): void {
  const grants = heldGrants();
  for (const listener of heldGrantListeners) listener(grants);
}

/** The open library's id, which its host routes carry in the path; null for a visitor. */
export function libraryCredentialId(): string | null {
  return libraryId;
}

/**
 * A fetcher scoped to one household's host-grant routes. Profile mode keeps the household control library and the
 * active person's library open together, so the singleton relay credential may belong to Owner while Sharing must
 * still administer grants owned by the household. This capability is explicit and cannot escape that household's
 * `/lib/:id/grants` subtree.
 */
export function hostGrantsFetch(membership: LibraryRelayMembership): typeof fetch {
  const claim = `${membership.libraryId}:${membership.memberToken}`;
  return async (input, init) => {
    const href =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const url = ours(href);
    if (!url || HOST_GRANTS.exec(url.pathname)?.[1] !== membership.libraryId)
      return fetch(input, init);
    const inherited = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const headers = new Headers(inherited);
    headers.delete(GRANT_HEADER);
    headers.set(MEMBER_HEADER, claim);
    return fetch(input, { ...init, headers });
  };
}

/**
 * A fetcher that proves one household's membership on the assistant routes (approving a connection, listing them,
 * the drop-box key, draining and acknowledging the queue). On a household split into profiles the singleton
 * credential may be Owner's, while an assistant connection is the household's: it is approved for, and queues to,
 * the household's library. Every other call is plain `fetch`.
 */
export function householdAssistantFetch(membership: LibraryRelayMembership): typeof fetch {
  const claim = `${membership.libraryId}:${membership.memberToken}`;
  return async (input, init) => {
    const href =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const url = ours(href);
    if (!url || !(OAUTH.test(url.pathname) || ASSISTANT.test(url.pathname)))
      return fetch(input, init);
    const inherited = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const headers = new Headers(inherited);
    headers.delete(GRANT_HEADER);
    headers.set(MEMBER_HEADER, claim);
    return fetch(input, { ...init, headers });
  };
}

/** Remember a grant's secret, so calls to its `~<gid>` addons can carry it. */
export function rememberGrant(gid: string, secret: string): void {
  if (grantSecrets.get(gid) === secret) return;
  grantSecrets.set(gid, secret);
  unheldWarned.delete(gid);
  grantsChanged();
}

/** Forget a grant's secret: it ended, or this browser left it. */
export function forgetGrant(gid: string): void {
  if (grantSecrets.delete(gid)) grantsChanged();
}

/** Hold exactly `grants`: what the library Worker does with each set the page sends it. */
export function useHeldGrants(grants: readonly HeldGrant[]): void {
  for (const gid of [...grantSecrets.keys()])
    if (!grants.some((grant) => grant.gid === gid)) forgetGrant(gid);
  for (const { gid, secret } of grants) rememberGrant(gid, secret);
}

/**
 * Told the held grants now and after every change, so the library Worker, which makes the content calls with a module
 * of its own, can hold the same ones (`useHeldGrants`).
 */
export function onHeldGrants(listener: (grants: HeldGrant[]) => void): () => void {
  heldGrantListeners.add(listener);
  listener(heldGrants());
  return () => heldGrantListeners.delete(listener);
}

/** Told when den-edge answers a grant's call with `grant_expired`, so the page can say the access ended. */
export function onGrantEnded(listener: ((gid: string) => void) | null): void {
  grantEnded = listener;
}

/** The library Worker saw `grant_expired` for a grant: tell this page's listener, as a call of its own would. */
export function grantEndedElsewhere(gid: string): void {
  grantEnded?.(gid);
}

/** Whether this browser can authenticate a shared-cache write, without exposing the credential itself. */
export function hasLibraryCredential(): boolean {
  return credential !== null;
}

/** The member proof for a same-origin native setup POST. Never put this value in a URL. */
export function libraryConfigureClaim(): string | null {
  return credential;
}

/** Which credential this browser holds, as a number that changes whenever it is set or forgotten. */
export function credentialVersion(): number {
  return version;
}

/** Remember the open library's credential, so relayed calls can prove membership. */
export function useLibraryCredential(keys: Pick<LibraryKeys, 'id' | 'member'>): void {
  credential = `${keys.id}:${keys.member}`;
  libraryId = keys.id;
  version++;
}

/** Install the bounded relay capability returned by LibraryService, without giving the page the library key. */
export function useLibraryRelayMembership(membership: LibraryRelayMembership): () => void {
  credential = `${membership.libraryId}:${membership.memberToken}`;
  libraryId = membership.libraryId;
  version++;
  const installed = version;
  return () => {
    if (version === installed) forgetLibraryCredential();
  };
}

/**
 * Hold page-owned member-sensitive relay traffic behind one library hello.
 *
 * The returned release is tokenized: closing a replaced connection cannot clear the newer connection's barrier.
 * A failed hello deliberately leaves a rejected barrier in place until replacement or close, so Den never retries
 * paired traffic anonymously after its library failed to open.
 */
export function holdLibraryRelayMembership(opening: Promise<unknown>): () => void {
  const token = Symbol('library relay bootstrap');
  const ready = opening.then(() => undefined);
  membershipOpening = { ready, token };
  void ready.catch(() => undefined);
  void ready.then(
    () => {
      if (membershipOpening?.token === token) membershipOpening = null;
    },
    () => undefined,
  );
  return () => {
    if (membershipOpening?.token === token) membershipOpening = null;
  };
}

/** Forget it — an unlinked browser is a visitor again, and must stop claiming otherwise. */
export function forgetLibraryCredential(): void {
  credential = null;
  libraryId = null;
  version++;
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
    return url.origin === new URL(here).origin ||
      (__DEN_TV_API_ORIGIN__ && url.origin === apiOrigin()) ||
      (__DEN_TV_SERVICE_ORIGIN__ && url.origin === serviceOrigin())
      ? url
      : null;
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
      remuxControl(url.pathname) ||
      OAUTH.test(url.pathname) ||
      ASSISTANT.test(url.pathname) ||
      url.pathname === DEN_CONFIGURE_SESSION ||
      (libraryId !== null && HOST_GRANTS.exec(url.pathname)?.[1] === libraryId))
  );
}

/** A same-origin route whose authorization changes once a paired library hello finishes. */
function membershipSensitive(url: URL): boolean {
  return (
    RELAYED.some((path) => url.pathname.startsWith(path)) ||
    remuxControl(url.pathname) ||
    OAUTH.test(url.pathname) ||
    ASSISTANT.test(url.pathname) ||
    url.pathname === DEN_CONFIGURE_SESSION ||
    HOST_GRANTS.test(url.pathname)
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
  if (OAUTH.test(url.pathname)) return credential ? null : (heldGrant() ?? null);
  if (!remuxControl(url.pathname)) return null;
  if (typeof init?.body === 'string') {
    try {
      const install = (JSON.parse(init.body) as { scout?: unknown }).scout;
      const gid = typeof install === 'string' ? GRANT_INSTALL.exec(install)?.[1] : undefined;
      if (gid && grantSecrets.has(gid)) return gid;
    } catch {
      // Not JSON: nothing names a grant.
    }
  }
  return credential ? null : (heldGrant() ?? null);
}

/** A grant this browser holds, for a call that needs some proof and has no member's to give. */
function heldGrant(): string | undefined {
  return grantSecrets.keys().next().value;
}

/** Whether this browser can prove anything: that it holds a library here, or a live grant. */
export function canProve(): boolean {
  return credential !== null || grantSecrets.size > 0;
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
  // Sent bare, den-edge answers the same 404 as for a missing path, which read as "nothing here" and quietly put
  // TMDB in Atlas's place: a call this browser cannot prove is refused here, out loud.
  if (!secret) {
    if (!unheldWarned.has(gid)) {
      unheldWarned.add(gid);
      console.warn(`den: no secret held for grant ${gid}; its shared addons are not asked`);
    }
    throw new TypeError(`no secret held for grant ${gid}`);
  }
  headers.set(GRANT_HEADER, `${gid}:${secret}`);
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
export const relayFetch: typeof fetch = async (input, init) => {
  const href =
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const url = ours(href);
  const opening = url && membershipSensitive(url) ? membershipOpening?.ready : undefined;
  if (opening) await opening;
  const gid = url && grantOf(url, init);
  if (gid) return guestFetch(gid, input, init);
  if (!credential || !relayed(href)) return fetch(input, init);
  const inherited = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  const headers = new Headers(inherited);
  headers.set(MEMBER_HEADER, credential);
  return fetch(input, { ...init, headers });
};
