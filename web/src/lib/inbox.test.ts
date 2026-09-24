import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { receiveDeviceIdentity, sealMessage, sendToTV } from './inbox';
import { linkKeys } from './pair';
import { fromHex } from './wire';

// den-spec, checked out at the repository root; the TV opens the same messages.
const vectors = JSON.parse(
  readFileSync(new URL('../../../spec/vectors/inbox-v1.json', import.meta.url), 'utf8'),
) as {
  linkKey: string;
  enc: string;
  cases: { nonce: string; plaintext: string; sealed: string }[];
  device: { nonce: string; plaintext: string; sealed: string };
};

describe('inbox v1 matches den-spec', () => {
  it("derives the link's sealing key", async () => {
    expect((await linkKeys(fromHex(vectors.linkKey))).enc).toEqual(fromHex(vectors.enc));
  });

  it.each(vectors.cases)('seals $plaintext', async ({ nonce, plaintext, sealed }) => {
    const { id, sentAt, message } = JSON.parse(plaintext) as {
      id: string;
      sentAt: number;
      message: object;
    };
    expect(
      await sealMessage(fromHex(vectors.enc), message, { id, sentAt, nonce: fromHex(nonce) }),
    ).toBe(sealed);
  });
});

describe('sending to a TV', () => {
  const play = { type: 'play', tmdbId: 550, mediaType: 'movie', title: 'Fight Club' };
  function capture() {
    const sent: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (_: string, init?: RequestInit) => {
      sent.push({
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;
    return { sent, fetchImpl };
  }

  const link = {
    inboxKey: 'abcdef0123456789',
    linkKey: btoa(String.fromCharCode(...fromHex(vectors.linkKey))),
  };

  it('seals, and sends nothing readable', async () => {
    const { sent, fetchImpl } = capture();
    expect(await sendToTV(link, play, fetchImpl)).toBe(true);
    expect(sent[0]?.headers['x-den-link']).toBe('abcdef0123456789');
    expect(Object.keys(sent[0]?.body ?? {})).toEqual(['sealed']);
    expect(JSON.stringify(sent[0]?.body)).not.toContain('Fight Club');
  });

  it('says so when den-edge is out of reach', async () => {
    const down = (async () => {
      throw new TypeError('offline');
    }) as typeof fetch;
    expect(await sendToTV(link, play, down)).toBe(false);
  });
});

describe('receiving a paired device identity', () => {
  it('opens den-spec’s pinned sealed identity vector', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ messages: [{ sealed: vectors.device.sealed }] }), {
        status: 200,
      })) as typeof fetch;
    expect(await receiveDeviceIdentity(link, fetchImpl, 1_789_000_120_000)).toEqual({
      name: 'Mac · Chrome',
      deviceId: '0011223344556677',
    });
  });

  it('opens the sealed stable id and ignores readable relay content', async () => {
    const sealed = await sealMessage(
      fromHex(vectors.enc),
      { type: 'device', name: ' Bedroom TV ', deviceId: 'a1b2c3d4e5f60718' },
      { sentAt: Date.now() },
    );
    const fetchImpl = (async (_: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['x-den-link']).toBe('abcdef0123456789');
      return new Response(
        JSON.stringify({
          messages: [{ type: 'device', name: 'forged' }, { sealed: 'not-base64!' }, { sealed }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    expect(await receiveDeviceIdentity(link, fetchImpl)).toEqual({
      name: 'Bedroom TV',
      deviceId: 'a1b2c3d4e5f60718',
    });
  });

  it('rejects malformed-present ids and malformed or replayed envelopes', async () => {
    const identity = { type: 'device', name: 'Bedroom TV', deviceId: 'a1b2c3d4e5f60718' };
    const now = 1_800_000_000_000;
    const response = (sealed: string) =>
      (async () =>
        new Response(JSON.stringify({ messages: [{ sealed }] }), { status: 200 })) as typeof fetch;
    const invalidDevice = await sealMessage(
      fromHex(vectors.enc),
      { ...identity, deviceId: 'A1b2c3d4e5f60718' },
      { id: '10000000000000000000000000000000', sentAt: now },
    );
    expect(await receiveDeviceIdentity(link, response(invalidDevice), now)).toBeNull();
    const missingEnvelopeId = await sealMessage(fromHex(vectors.enc), identity, {
      id: 'bad',
      sentAt: now,
    });
    expect(await receiveDeviceIdentity(link, response(missingEnvelopeId), now)).toBeNull();

    const replayed = await sealMessage(fromHex(vectors.enc), identity, {
      id: '20000000000000000000000000000000',
      sentAt: now,
    });
    expect(await receiveDeviceIdentity(link, response(replayed), now)).toEqual({
      name: 'Bedroom TV',
      deviceId: identity.deviceId,
    });
    expect(await receiveDeviceIdentity(link, response(replayed), now)).toBeNull();
  });

  it('keeps a legacy name-only device message without inventing an id', async () => {
    const now = 1_800_000_100_000;
    const sealed = await sealMessage(
      fromHex(vectors.enc),
      { type: 'device', name: ' Old browser ' },
      { id: '30000000000000000000000000000000', sentAt: now },
    );
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ messages: [{ sealed }] }), { status: 200 })) as typeof fetch;
    expect(await receiveDeviceIdentity(link, fetchImpl, now)).toEqual({ name: 'Old browser' });
  });

  it('finds nothing in a refused or failing drain', async () => {
    const status = (code: number) =>
      (async () => new Response('{}', { status: code })) as typeof fetch;
    expect(await receiveDeviceIdentity(link, status(429))).toBeNull();
    expect(await receiveDeviceIdentity(link, status(503))).toBeNull();
  });

  const link = {
    inboxKey: 'abcdef0123456789',
    linkKey: btoa(String.fromCharCode(...fromHex(vectors.linkKey))),
  };
});
