import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sealMessage, sendToTV } from './inbox';
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

describe('sending to a TV', () => {
  const play = { type: 'play', tmdbId: 550, mediaType: 'movie', title: 'Fight Club' };
  function capture() {
    const sent: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (_: string, init?: RequestInit) => {
      sent.push({ headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;
    return { sent, fetchImpl };
  }

  it('seals for a paired link, and sends nothing readable', async () => {
    const { sent, fetchImpl } = capture();
    const linkKey = btoa(String.fromCharCode(...fromHex(vectors.linkKey)));
    expect(await sendToTV({ inboxKey: 'abcdef0123456789', linkKey }, play, fetchImpl)).toBe(true);
    expect(sent[0]?.headers['x-den-link']).toBe('abcdef0123456789');
    expect(Object.keys(sent[0]?.body ?? {})).toEqual(['sealed']);
    expect(JSON.stringify(sent[0]?.body)).not.toContain('Fight Club');
  });

  it('sends as it is, with the time, for a six-character link', async () => {
    const { sent, fetchImpl } = capture();
    expect(await sendToTV({ inboxKey: 'abcdef0123456789' }, play, fetchImpl)).toBe(true);
    const message = sent[0]?.body.message as Record<string, unknown>;
    expect(message).toMatchObject(play);
    expect(typeof message.sentAt).toBe('number');
  });

  it('says so when den-edge is out of reach', async () => {
    const down = (async () => {
      throw new TypeError('offline');
    }) as typeof fetch;
    expect(await sendToTV({ inboxKey: 'abcdef0123456789' }, play, down)).toBe(false);
  });
});
