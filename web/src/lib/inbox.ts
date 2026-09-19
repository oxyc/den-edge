// A paired TV's inbox messages, sealed under the link's key (den-spec wire/inbox-v1.md): den-edge stores them and
// can't read, forge or replay them. inbox.test.ts checks the sealing against den-spec's vectors, which the TV
// opens too.

import { hex, hkdf } from './crypto';
import { cleanLabel } from './edge';
import type { Link } from './links.svelte';
import { fromBase64url, toBase64url } from './wire';

type Bytes = Uint8Array<ArrayBuffer>;

/**
 * What a link key derives: `inbox`, the link's credential at den-edge, and `enc`, its inbox messages' key. Here rather
 * than in pair.ts, so sending to a TV doesn't load the pairing curve.
 */
export async function linkKeys(linkKey: Bytes): Promise<{ inbox: string; enc: Bytes }> {
  const [inbox, enc] = await Promise.all([
    hkdf(linkKey, 'den/link/v1', 'inbox', 24),
    hkdf(linkKey, 'den/link/v1', 'enc', 32),
  ]);
  return { inbox: hex(inbox), enc };
}

const AAD = new TextEncoder().encode('den/inbox/v1');
const REPLAY_KEY = 'den.inboxReplay.v1';
const SEAL_WINDOW = 7 * 24 * 60 * 60 * 1000;
const SEAL_AHEAD = 24 * 60 * 60 * 1000;
const visitReplay = new Map<string, number>();

function replayEntries(storage: Storage | undefined, now: number): Record<string, number> {
  try {
    const parsed = JSON.parse(storage?.getItem(REPLAY_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => {
        const [id, expires] = entry;
        return /^[0-9a-f]{32}$/.test(id) && typeof expires === 'number' && expires > now;
      }),
    );
  } catch {
    return {};
  }
}

/** Admit a sealed envelope once for the queue's lifetime, including across page reloads. */
function admit(id: string, now: number, storage: Storage | undefined): boolean {
  for (const [seen, expires] of visitReplay) if (expires <= now) visitReplay.delete(seen);
  const kept = replayEntries(storage, now);
  if (visitReplay.has(id) || kept[id]) return false;
  const expires = now + SEAL_WINDOW;
  visitReplay.set(id, expires);
  kept[id] = expires;
  try {
    storage?.setItem(REPLAY_KEY, JSON.stringify(kept));
  } catch {
    // The visit-scoped map still refuses the replay when site data is unavailable.
  }
  return true;
}

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
  try {
    const { enc } = await linkKeys(Uint8Array.from(atob(link.linkKey), (c) => c.charCodeAt(0)));
    return appendSealed(link.inboxKey, enc, message, fetchImpl);
  } catch {
    return false;
  }
}

/** Queue one sealed message using a raw pairing link key. */
export async function sendToLink(
  linkKey: Bytes,
  message: object,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const { inbox, enc } = await linkKeys(linkKey);
    return appendSealed(inbox, enc, message, fetchImpl);
  } catch {
    return false;
  }
}

async function appendSealed(
  inbox: string,
  enc: Bytes,
  message: object,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const body = { sealed: await sealMessage(enc, message) };
  try {
    const res = await fetchImpl('/inbox/append', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-den-link': inbox },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface DeviceIdentity {
  name: string;
  deviceId?: string;
}

/**
 * Drain a hosted pairing's inbox for the joiner's authenticated stable identity. Browser hosts keep the link key
 * until this arrives; old joiners simply leave the record name-only for the conservative legacy fallback.
 */
export async function receiveDeviceIdentity(
  link: Pick<Link, 'inboxKey' | 'linkKey'>,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
  storage: Storage | undefined = globalThis.localStorage,
): Promise<DeviceIdentity | null> {
  try {
    const response = await fetchImpl('/inbox/drain', {
      headers: { 'x-den-link': link.inboxKey },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { messages?: { sealed?: unknown }[] };
    if (!Array.isArray(body.messages)) return null;
    const { enc } = await linkKeys(Uint8Array.from(atob(link.linkKey), (c) => c.charCodeAt(0)));
    const key = await crypto.subtle.importKey('raw', enc, 'AES-GCM', false, ['decrypt']);
    let newest: (DeviceIdentity & { sentAt: number }) | null = null;
    for (const entry of body.messages) {
      if (typeof entry.sealed !== 'string') continue;
      try {
        const combined = fromBase64url(entry.sealed);
        if (combined.length < 28) continue;
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: combined.slice(0, 12), additionalData: AAD },
          key,
          combined.slice(12),
        );
        const envelope = JSON.parse(new TextDecoder().decode(plain)) as {
          id?: unknown;
          sentAt?: unknown;
          message?: { type?: unknown; name?: unknown; deviceId?: unknown };
        };
        const name =
          typeof envelope.message?.name === 'string' ? cleanLabel(envelope.message.name) : '';
        const id = envelope.message?.deviceId;
        const hasId = Object.prototype.hasOwnProperty.call(envelope.message ?? {}, 'deviceId');
        const sentAt = envelope.sentAt;
        const age = typeof sentAt === 'number' ? now - sentAt : Number.POSITIVE_INFINITY;
        if (
          typeof envelope.id === 'string' &&
          /^[0-9a-f]{32}$/.test(envelope.id) &&
          envelope.message?.type === 'device' &&
          name &&
          (!hasId || (typeof id === 'string' && /^[0-9a-f]{16}$/.test(id))) &&
          typeof sentAt === 'number' &&
          Number.isFinite(sentAt) &&
          age <= SEAL_WINDOW &&
          age >= -SEAL_AHEAD &&
          admit(envelope.id, now, storage) &&
          (!newest || sentAt > newest.sentAt)
        ) {
          newest = { name, ...(hasId ? { deviceId: id as string } : {}), sentAt };
        }
      } catch {
        // A malformed or differently keyed message does not identify this link.
      }
    }
    if (newest)
      return {
        name: newest.name,
        ...(newest.deviceId ? { deviceId: newest.deviceId } : {}),
      };
  } catch {
    // The record stays pending and can retry when Settings opens again.
  }
  return null;
}
