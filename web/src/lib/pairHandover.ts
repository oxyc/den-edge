import { fromBase64url, toBase64url } from './wire';

type Bytes = Uint8Array<ArrayBuffer>;

const utf8 = new TextEncoder();
const HANDOVER = utf8.encode('den/pair/v1/handover');

export const isStampDeviceId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);

export const isGrantTicket = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}\.[A-Za-z0-9_-]{22}$/.test(value);

export interface Handover {
  host: string;
  /** Stable library stamp id of the host. Missing on handovers from older clients. */
  hostDeviceId?: string;
  linkKey: Bytes;
  libraryKey: Bytes;
  /** A one-use guest-device ticket, carried only inside the encrypted handover. */
  grantTicket?: string;
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function aes(key: Bytes, use: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', key, 'AES-GCM', false, [use]);
}

export async function sealHandover(
  key: Bytes,
  handover: Handover,
  nonce = crypto.getRandomValues(new Uint8Array(12)),
) {
  const plaintext = JSON.stringify({
    v: 1,
    host: handover.host,
    ...(handover.hostDeviceId ? { hostDeviceId: handover.hostDeviceId } : {}),
    ...(handover.grantTicket ? { grantTicket: handover.grantTicket } : {}),
    linkKey: toBase64url(handover.linkKey),
    libraryKey: toBase64url(handover.libraryKey),
  });
  const params = { name: 'AES-GCM', iv: nonce, additionalData: HANDOVER };
  return concat(
    nonce,
    new Uint8Array(
      await crypto.subtle.encrypt(params, await aes(key, 'encrypt'), utf8.encode(plaintext)),
    ),
  );
}

/** The host's handover, or null when it doesn't open or lacks a key. */
export async function openHandover(key: Bytes, d: Uint8Array): Promise<Handover | null> {
  if (d.length < 12 + 16) return null;
  try {
    const params = { name: 'AES-GCM', iv: d.slice(0, 12), additionalData: HANDOVER };
    const plain = await crypto.subtle.decrypt(params, await aes(key, 'decrypt'), d.slice(12));
    const body = JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
    const linkKey = typeof body.linkKey === 'string' ? fromBase64url(body.linkKey) : null;
    const libraryKey = typeof body.libraryKey === 'string' ? fromBase64url(body.libraryKey) : null;
    if (body.hostDeviceId !== undefined && !isStampDeviceId(body.hostDeviceId)) return null;
    if (body.grantTicket !== undefined && !isGrantTicket(body.grantTicket)) return null;
    const hostDeviceId = isStampDeviceId(body.hostDeviceId) ? body.hostDeviceId : undefined;
    if (typeof body.host !== 'string' || linkKey?.length !== 32 || libraryKey?.length !== 32)
      return null;
    return {
      host: body.host,
      ...(hostDeviceId ? { hostDeviceId } : {}),
      ...(isGrantTicket(body.grantTicket) ? { grantTicket: body.grantTicket } : {}),
      linkKey,
      libraryKey,
    };
  } catch {
    return null;
  }
}
