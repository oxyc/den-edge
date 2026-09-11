import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sealMessage } from './inbox';
import { linkKeys } from './pair';
import { fromHex } from './wire';

// den-spec, checked out at the repository root; the TV opens the same messages.
const vectors = JSON.parse(readFileSync(new URL('../../../spec/vectors/inbox-v1.json', import.meta.url), 'utf8')) as {
  linkKey: string;
  enc: string;
  cases: { nonce: string; plaintext: string; sealed: string }[];
};

describe('inbox v1 matches den-spec', () => {
  it("derives the link's sealing key", async () => {
    expect((await linkKeys(fromHex(vectors.linkKey))).enc).toEqual(fromHex(vectors.enc));
  });

  it.each(vectors.cases)('seals $plaintext', async ({ nonce, plaintext, sealed }) => {
    const { id, sentAt, message } = JSON.parse(plaintext) as { id: string; sentAt: number; message: object };
    expect(await sealMessage(fromHex(vectors.enc), message, { id, sentAt, nonce: fromHex(nonce) })).toBe(sealed);
  });
});
