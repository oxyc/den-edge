import { hkdf } from './crypto';

/** The key browser-local library state is sealed under: derived from the library key and good for nothing else. */
export async function libraryLocalKey(libraryKey: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const bytes = await hkdf(libraryKey, 'den/web/local/v1', 'enc', 32);
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
