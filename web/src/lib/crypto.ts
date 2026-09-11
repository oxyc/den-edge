// The library backup's crypto, exactly as DenKit's ConfigCrypto does it: the key is HKDF-SHA256 of the link's
// inbox key, the /sync id is HKDF of that key, and the blob is AES-256-GCM with the tag on the end of the
// ciphertext. crypto.test.ts holds CryptoKit's answers for a fixed key, so a drift shows up as a failure.

const utf8 = new TextEncoder();

export async function hkdf(material: Uint8Array<ArrayBuffer>, salt: string, info: string, bytes: number) {
  const key = await crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8.encode(salt), info: utf8.encode(info) },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** The library key the TV and every linked device derive from their shared inbox key. */
export function libraryKey(inboxKey: string): Promise<Uint8Array<ArrayBuffer>> {
  return hkdf(utf8.encode(inboxKey), 'den/library/key/v1', '', 32);
}

/** Where the library backup lives on den-edge: `/sync/<id>`. */
export async function libraryId(key: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await hkdf(key, 'den/library/salt/v1', 'den/library/id/v1', 16));
}

export interface Sealed {
  ciphertext: string;
  nonce: string;
}

/** Open a sealed blob; rejects when the key is wrong or the blob was tampered with. */
export async function open(key: Uint8Array<ArrayBuffer>, sealed: Sealed): Promise<Uint8Array> {
  const aes = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(sealed.nonce), tagLength: 128 },
    aes,
    fromBase64(sealed.ciphertext),
  );
  return new Uint8Array(plain);
}
