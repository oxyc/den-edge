import { describe, expect, it } from 'vitest';
import { linkKeys, receiveDeviceIdentities, sealMessage } from './inbox';

// inbox.test.ts checks the sealing against den-spec's vectors; this needs none, so it runs without spec/.
const linkKey = (fill: number) => new Uint8Array(32).fill(fill);
const link = (fill: number) => ({
  inboxKey: fill.toString(16).padStart(2, '0').repeat(8),
  linkKey: btoa(String.fromCharCode(...linkKey(fill))),
});

async function identity(fill: number, name: string, id: string, now: number) {
  const { enc } = await linkKeys(linkKey(fill));
  return sealMessage(enc, { type: 'device', name }, { id, sentAt: now });
}

describe('receiveDeviceIdentities', () => {
  it('drains every link in one request, and says which queue held which device', async () => {
    const now = 1_800_000_000_000;
    const [phone, tablet, idle] = [link(1), link(2), link(3)];
    const asked: unknown[] = [];
    const queues = [
      [{ sealed: await identity(1, 'Phone', 'a'.repeat(32), now) }],
      [{ sealed: await identity(1, 'Sealed for another link', 'b'.repeat(32), now) }],
      [],
    ];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      asked.push([url, init?.method, JSON.parse(String(init?.body))]);
      return new Response(JSON.stringify({ queues }), { status: 200 });
    }) as typeof fetch;
    const found = await receiveDeviceIdentities([phone, tablet, idle, phone], fetchImpl, now);
    expect(asked).toEqual([
      ['/inbox/drain', 'POST', { keys: [phone.inboxKey, tablet.inboxKey, idle.inboxKey] }],
    ]);
    expect(found).toEqual(
      new Map([
        [phone.inboxKey, { name: 'Phone' }],
        [tablet.inboxKey, null],
        [idle.inboxKey, null],
      ]),
    );
  });

  it('asks sixteen queues at a time, as den-edge takes them, and leaves out a batch it refused', async () => {
    const many = Array.from({ length: 20 }, (_, i) => link(i + 1));
    const sizes: number[] = [];
    const fetchImpl = (async (_: string, init?: RequestInit) => {
      const { keys } = JSON.parse(String(init?.body)) as { keys: string[] };
      sizes.push(keys.length);
      if (keys.length < 16) return new Response('{"error":"rate_limited"}', { status: 429 });
      return new Response(JSON.stringify({ queues: keys.map(() => []) }), { status: 200 });
    }) as typeof fetch;
    const found = await receiveDeviceIdentities(many, fetchImpl);
    expect(sizes).toEqual([16, 4]);
    expect(found.size).toBe(16);
  });
});
