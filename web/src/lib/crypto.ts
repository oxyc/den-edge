// HKDF-SHA256 and hex, which the wire formats share. Their tests are den-spec's vectors (wire.test.ts,
// pair.test.ts, inbox.test.ts).

const utf8 = new TextEncoder();

export async function hkdf(
  material: Uint8Array<ArrayBuffer>,
  salt: string | Uint8Array<ArrayBuffer>,
  info: string,
  bytes: number,
) {
  const key = await crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: typeof salt === 'string' ? utf8.encode(salt) : salt,
      info: utf8.encode(info),
    },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
