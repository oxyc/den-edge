import { describe, expect, it } from 'vitest';
import { claimCode } from './edge';
import { readLinks } from './links.svelte';

function answering(status: number, body: unknown = {}): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

describe('claimCode', () => {
  it('sends the code upper-cased and returns the shared key', async () => {
    let sent: unknown;
    const fetchImpl: typeof fetch = async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ inboxKey: 'deadbeefcafe1234' }), { status: 200 });
    };
    expect(await claimCode(' ab3cde ', fetchImpl)).toEqual({ inboxKey: 'deadbeefcafe1234' });
    expect(sent).toEqual({ code: 'AB3CDE' });
  });

  it('names what went wrong', async () => {
    expect(await claimCode('X', answering(410))).toEqual({ error: 'expired' });
    expect(await claimCode('X', answering(409))).toEqual({ error: 'claimed' });
    expect(await claimCode('X', answering(429))).toEqual({ error: 'throttled' });
    expect(await claimCode('X', answering(500))).toEqual({ error: 'unreachable' });
    expect(await claimCode('X', async () => Promise.reject(new TypeError('offline')))).toEqual({
      error: 'unreachable',
    });
  });

  it('does not take a malformed key', async () => {
    expect(await claimCode('X', answering(200, { inboxKey: 'not hex!' }))).toEqual({ error: 'unreachable' });
  });
});

describe('readLinks', () => {
  function storage(raw: string | null, throws = false): Storage {
    return {
      getItem: () => {
        if (throws) throw new Error('blocked');
        return raw;
      },
    } as unknown as Storage;
  }

  it('keeps only well-formed links and survives storage that throws', () => {
    const good = { inboxKey: 'deadbeefcafe1234', linkedAt: 1 };
    expect(readLinks(storage(JSON.stringify([good, { inboxKey: 3 }])))).toEqual([good]);
    expect(readLinks(storage('not json'))).toEqual([]);
    expect(readLinks(storage(null, true))).toEqual([]);
  });
});
