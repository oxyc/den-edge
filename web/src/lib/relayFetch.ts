// Proof that this browser holds a library here, sent with the addon calls that go through den-edge's relay.
//
// The relay budgets requests per address: a visitor gets enough to read pages, a member enough to browse
// properly. Membership is claimed with `x-den-library-member: <id>:<token>`, and until this existed the web
// app never sent it — so a paired household was charged the visitor's budget and refused part-way through
// rendering its own home page, with the billboard trailers stopping mid-render.
//
// ONLY the relayed prefixes get the header, and only same-origin. The token opens this library to anyone
// holding it, so attaching it to every request would hand it to api.themoviedb.org, omdbapi.com and whatever
// else a page happens to call. The allow-list is the security boundary here, not an optimisation.

import type { LibraryKeys } from './wire';

/** The paths den-edge relays to the addons (`ADDON_RELAY`). Anything else is somebody else's server. */
const RELAYED = ['/scout/', '/atlas/', '/reel/'];
const MEMBER_HEADER = 'x-den-library-member';

let credential: string | null = null;

/** Remember the open library's credential, so relayed calls can prove membership. */
export function useLibraryCredential(keys: Pick<LibraryKeys, 'id' | 'token'>): void {
  credential = `${keys.id}:${keys.token}`;
}

/** Forget it — an unlinked browser is a visitor again, and must stop claiming otherwise. */
export function forgetLibraryCredential(): void {
  credential = null;
}

function relayed(href: string): boolean {
  // With no page to compare against there is no telling our origin from anyone else's, and a path is not
  // enough on its own: `https://elsewhere.example/scout/…` has the same one. The safe answer is "not ours".
  const here = globalThis.location?.href;
  if (!here) return false;
  try {
    const url = new URL(href, here);
    return url.origin === new URL(here).origin && RELAYED.some((p) => url.pathname.startsWith(p));
  } catch {
    // An unparseable URL is not one of ours.
    return false;
  }
}

/**
 * `fetch`, with the membership claim attached to relayed addon calls and to nothing else.
 *
 * Safe as a default everywhere: with no library open, or for any other host, it is exactly `fetch`.
 */
export const relayFetch: typeof fetch = (input, init) => {
  const href =
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  if (!credential || !relayed(href)) return fetch(input, init);
  const inherited = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  const headers = new Headers(inherited);
  headers.set(MEMBER_HEADER, credential);
  return fetch(input, { ...init, headers });
};
