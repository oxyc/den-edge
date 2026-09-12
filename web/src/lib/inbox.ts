// A paired TV's inbox messages, sealed under the link's key (den-spec wire/inbox-v1.md): den-edge stores them and
// can't read, forge or replay them. inbox.test.ts checks the sealing against den-spec's vectors, which the TV
// opens too.

import { hex } from './crypto';
import type { Link } from './links.svelte';
import { linkKeys } from './pair';
import { toBase64url } from './wire';

type Bytes = Uint8Array<ArrayBuffer>;

const AAD = new TextEncoder().encode('den/inbox/v1');

/** The random parts of a sealed message, pinned by tests. */
export interface Sealing {
  id?: string;
  sentAt?: number;
  nonce?: Bytes;
}

/** `message` sealed under the link's `enc` key, as den-edge's `sealed` field carries it. */
export async function sealMessage(
  enc: Bytes,
  message: object,
  sealing: Sealing = {},
): Promise<string> {
  const {
    id = hex(crypto.getRandomValues(new Uint8Array(16))),
    sentAt = Date.now(),
    nonce = crypto.getRandomValues(new Uint8Array(12)),
  } = sealing;
  const plaintext = new TextEncoder().encode(JSON.stringify({ id, sentAt, message }));
  const key = await crypto.subtle.importKey('raw', enc, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: AAD },
      key,
      plaintext,
    ),
  );
  const out = new Uint8Array(nonce.length + sealed.length);
  out.set(nonce);
  out.set(sealed, nonce.length);
  return toBase64url(out);
}

/** Queue `message`, sealed, for the TV behind `link`. False when den-edge didn't take it. */
export async function sendToTV(
  link: Pick<Link, 'inboxKey' | 'linkKey'>,
  message: object,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const { enc } = await linkKeys(Uint8Array.from(atob(link.linkKey), (c) => c.charCodeAt(0)));
  const body = { sealed: await sealMessage(enc, message) };
  try {
    const res = await fetchImpl('/inbox/append', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-den-link': link.inboxKey },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}
