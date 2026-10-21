// A TV-initiated pairing link. The ordinary twelve-character pairing code stays in the fragment, so a camera app
// may open the HTTPS address without the code reaching den-edge, a reverse proxy, browser history or referrers.

import { parseCode } from './pairCode';

/** An HTTPS address any camera app can open to give the current Den library to the waiting TV. */
export function tvLink(origin: string, code: string): string {
  const parsed = parseCode(code);
  if (!parsed) throw new Error('invalid TV pairing code');
  const normalized = `${parsed.nameplate}${parsed.secret}`;
  return `${origin}/settings#tv=${normalized}`;
}

/** The pairing code in a scanned TV link, or null for every other fragment/address. */
export function parseTVLink(input: string): string | null {
  const hash = input.trim().split('#')[1];
  if (hash === undefined) return null;
  const code = new URLSearchParams(hash).get('tv');
  const parsed = code ? parseCode(code) : null;
  return parsed ? `${parsed.nameplate}${parsed.secret}` : null;
}
