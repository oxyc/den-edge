// "Use Den on your phone": a link a guest's laptop makes and the phone opens. The library key and the device ticket
// travel in the URL fragment, which no browser sends to a server, so den-edge never reads either. The key is the
// guest's whole library, so the link is for the guest's own eyes and devices; the ticket in it is good for ten minutes
// and one device (den-edge `POST /grant/device-ticket`).

import { ticketGrant } from './grants';
import { fromBase64url, toBase64url } from './wire';

export interface PhoneLink {
  /** Absent when the laptop's grant had ended: the phone then joins the library without the host's addons. */
  ticket: string | null;
  /** The library key, base64, as `Link.libraryKey` keeps it. */
  libraryKey: string;
}

export function phoneLink(origin: string, link: PhoneLink): string {
  const bytes = Uint8Array.from(atob(link.libraryKey), (c) => c.charCodeAt(0));
  const parts = new URLSearchParams();
  if (link.ticket) parts.set('phone', link.ticket);
  parts.set('k', toBase64url(bytes));
  return `${origin}/#${parts.toString()}`;
}

/** The link in what was pasted or opened (`#phone=<ticket>&k=<key>`), or null when it isn't one. */
export function parsePhoneLink(input: string): PhoneLink | null {
  const hash = input.trim().split('#')[1];
  if (hash === undefined) return null;
  const params = new URLSearchParams(hash);
  const key = params.get('k');
  if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key)) return null;
  const ticket = params.get('phone');
  if (ticket !== null && !ticketGrant(ticket)) return null;
  const bytes = fromBase64url(key);
  if (bytes.length !== 32) return null;
  return { ticket, libraryKey: btoa(String.fromCharCode(...bytes)) };
}
