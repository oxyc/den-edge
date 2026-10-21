import { libraryLocalKey } from './libraryLocalKey';
import { noteLibraryCacheIO } from './libraryStartupMetrics';
import type { Vault } from './localVault';
import { deriveKeys } from './wire';

const utf8 = new TextEncoder();
const text = new TextDecoder();

const rawLibraryKey = (encoded: string): Uint8Array<ArrayBuffer> | null => {
  try {
    const raw = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    if (raw.length !== 32 || btoa(String.fromCharCode(...raw)) !== encoded) return null;
    return raw;
  } catch {
    return null;
  }
};

export async function libraryLocalMaterials(libraryKey: string) {
  const raw = rawLibraryKey(libraryKey);
  if (!raw) return null;
  try {
    const keys = await deriveKeys(raw);
    return { libraryId: keys.id, key: await libraryLocalKey(raw) };
  } finally {
    raw.fill(0);
  }
}

export async function sealLibraryLocalValue(
  key: CryptoKey,
  aad: string,
  value: unknown,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8.encode(aad) },
    key,
    utf8.encode(JSON.stringify(value)),
  );
  const bytes = new Uint8Array(iv.length + sealed.byteLength);
  bytes.set(iv);
  bytes.set(new Uint8Array(sealed), iv.length);
  return bytes;
}

export async function openLibraryLocalValue(
  key: CryptoKey,
  aad: string,
  bytes: Uint8Array,
): Promise<unknown> {
  if (bytes.length < 13) throw new Error('truncated local value');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: utf8.encode(aad) },
    key,
    bytes.slice(12),
  );
  return JSON.parse(text.decode(plain)) as unknown;
}

/** Open one small encrypted value without opening the saved document snapshot. */
export async function readEncryptedLibraryValue<T>(
  libraryKey: string,
  vault: Vault,
  name: string,
): Promise<T | undefined> {
  const local = await libraryLocalMaterials(libraryKey);
  if (!local) return undefined;
  const bytes = await vault.get(`${local.libraryId}:${name}`);
  if (!bytes) return undefined;
  noteLibraryCacheIO('read', bytes.byteLength);
  try {
    return (await openLibraryLocalValue(local.key, name, bytes)) as T;
  } catch {
    return undefined;
  }
}

/** Replace one small encrypted value without opening the saved document snapshot. */
export async function writeEncryptedLibraryValue(
  libraryKey: string,
  vault: Vault,
  name: string,
  value: unknown,
): Promise<boolean> {
  const local = await libraryLocalMaterials(libraryKey);
  if (!local) return false;
  const bytes = await sealLibraryLocalValue(local.key, name, value);
  await vault.put(`${local.libraryId}:${name}`, bytes);
  noteLibraryCacheIO('write', bytes.byteLength);
  return true;
}
