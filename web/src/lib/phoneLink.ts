// "Use Den on your phone": a link a guest's laptop makes and the phone opens. It carries a pairing code (`pair.ts`) and,
// while the guest's grant lives, a device ticket (den-edge `POST /grant/device-ticket`) in the URL fragment, which no
// browser sends to a server. It does NOT carry the library key: the phone runs the pairing, the laptop asks before it
// hands the library over, and the key arrives sealed. So the link is worth nothing once its pairing session (ten
// minutes) is used or lapsed, whoever later sees it in a chat, a history or a photographed QR.

import { ticketGrant } from './grants';
import { parseCode } from './pair';

export interface PhoneLink {
  /** Absent when the laptop's grant had ended: the phone then joins the library without the host's addons. */
  ticket: string | null;
  /** The pairing code, twelve characters of the pairing alphabet. */
  code: string;
}

export function phoneLink(origin: string, link: PhoneLink): string {
  const parts = new URLSearchParams();
  if (link.ticket) parts.set('phone', link.ticket);
  parts.set('code', link.code);
  return `${origin}/#${parts.toString()}`;
}

/** The link in what was pasted or opened (`#phone=<ticket>&code=<code>`), or null when it isn't one. */
export function parsePhoneLink(input: string): PhoneLink | null {
  const hash = input.trim().split('#')[1];
  if (hash === undefined) return null;
  const params = new URLSearchParams(hash);
  const code = params.get('code');
  if (!code || !parseCode(code)) return null;
  const ticket = params.get('phone');
  if (ticket !== null && !ticketGrant(ticket)) return null;
  return { ticket, code: code.toUpperCase().replace(/[\s-]/g, '') };
}
