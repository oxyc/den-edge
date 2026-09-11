import { describe, expect, it } from 'vitest';
import { claimCode, deviceLabel } from './edge';
import { readLinks } from './links.svelte';

function answering(status: number, body: unknown = {}): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

describe('claimCode', () => {
  it('sends the code upper-cased with the device, and returns the shared key', async () => {
    let sent: unknown;
    const fetchImpl: typeof fetch = async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ inboxKey: 'deadbeefcafe1234' }), { status: 200 });
    };
    expect(await claimCode(' ab3cde ', fetchImpl, 'Mac')).toEqual({ inboxKey: 'deadbeefcafe1234' });
    expect(sent).toEqual({ code: 'AB3CDE', device: 'Mac' });
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

describe('deviceLabel', () => {
  const as = (userAgent: string, maxTouchPoints = 0) => deviceLabel({ userAgent, maxTouchPoints });

  it('names the device the way the TV will list it', () => {
    expect(as('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15')).toBe('Mac');
    expect(as('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', 5)).toBe('iPad');
    expect(as('Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148')).toBe('iPhone');
    expect(as('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36')).toBe(
      'Android phone',
    );
    expect(as('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36')).toBe(
      'Windows PC',
    );
    expect(as('curl/8.7.1')).toBe('Browser');
  });
});

describe('readLinks', () => {
  function storage(values: Record<string, string>, throws = false): Storage {
    return {
      getItem: (key: string) => {
        if (throws) throw new Error('blocked');
        return values[key] ?? null;
      },
    } as unknown as Storage;
  }

  it('reads the list the companion page keeps, and keeps only well-formed links', () => {
    const companion = { inboxKey: 'deadbeefcafe1234', name: 'Living room' };
    const junk = [{ inboxKey: 3 }, { inboxKey: 'not a key' }];
    expect(readLinks(storage({ 'den.links': JSON.stringify([companion, ...junk]) }))).toEqual([companion]);
  });

  it("picks up the companion page's older single link", () => {
    expect(readLinks(storage({ 'den.inboxKey': 'abcdef0123456789' }))).toEqual([
      { inboxKey: 'abcdef0123456789', name: 'Apple TV' },
    ]);
  });

  it('survives storage that is malformed or throws', () => {
    expect(readLinks(storage({ 'den.links': 'not json' }))).toEqual([]);
    expect(readLinks(storage({}, true))).toEqual([]);
  });
});
