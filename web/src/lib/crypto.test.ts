import { describe, expect, it } from 'vitest';
import { hex, libraryId, libraryKey, open } from './crypto';

// CryptoKit's answers, from DenKit's own derivation (ConfigCrypto) run on a Mac for this inbox key, and
// AES.GCM.seal of the plaintext below under a nonce of twelve 0x07 bytes.
const INBOX_KEY = 'deadbeefcafe1234deadbeefcafe1234deadbeefcafe1234';
const KEY = '5391c11b08e725880ea3adf678733707c6a05d0312ef677b0dce7dc26f679e02';
const ID = '3dcc8b2493141e44501dcf1bc331a7e1';
const SEALED = { ciphertext: 'NgRE/lOISCEhTZwPIZ0gXfoAuv5R+W/2ichNNN0PiPZiNF3fvEyCCyA54DY=', nonce: 'BwcHBwcHBwcHBwcH' };

describe('library crypto matches the TV', () => {
  it('derives the same key and /sync id as CryptoKit', async () => {
    const key = await libraryKey(INBOX_KEY);
    expect(hex(key)).toBe(KEY);
    expect(await libraryId(key)).toBe(ID);
  });

  it('opens a blob the TV sealed, and refuses it under another key', async () => {
    const key = await libraryKey(INBOX_KEY);
    expect(new TextDecoder().decode(await open(key, SEALED))).toBe('{"records":[],"createdAt":0}');
    await expect(open(await libraryKey('abcdef0123456789'), SEALED)).rejects.toThrow();
  });
});
