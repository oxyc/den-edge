import { describe, expect, it } from 'vitest';
import { deviceLabel } from './edge';
import { readLinks } from './links.svelte';

describe('deviceLabel', () => {
  const as = (userAgent: string, maxTouchPoints = 0) => deviceLabel({ userAgent, maxTouchPoints });

  it('names the device and browser the way the TV will list them', () => {
    const macSafari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15';
    expect(as(macSafari)).toBe('Mac · Safari');
    expect(as(macSafari, 5)).toBe('iPad · Safari');
    expect(as('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36')).toBe(
      'Mac · Chrome',
    );
    expect(as('Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148')).toBe('iPhone');
    expect(as('Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) CriOS/140.0 Mobile/15E148 Safari/604.1')).toBe(
      'iPhone · Chrome',
    );
    expect(as('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36')).toBe(
      'Android phone · Chrome',
    );
    expect(as('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 Edg/140.0')).toBe(
      'Windows PC · Edge',
    );
    expect(as('Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0')).toBe('Linux PC · Firefox');
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

  it('keeps only paired links: a six-character one has no keys and pairs again', () => {
    const paired = { inboxKey: 'deadbeefcafe1234', name: 'Living room', libraryKey: 'a2V5', linkKey: 'bGluaw==' };
    const older = { inboxKey: 'abcdef0123456789', name: 'Apple TV' };
    const junk = [{ inboxKey: 3 }, { inboxKey: 'not a key', libraryKey: 'a', linkKey: 'b' }];
    expect(readLinks(storage({ 'den.links': JSON.stringify([paired, older, ...junk]) }))).toEqual([paired]);
  });

  it('survives storage that is malformed or throws', () => {
    expect(readLinks(storage({ 'den.links': 'not json' }))).toEqual([]);
    expect(readLinks(storage({}, true))).toEqual([]);
  });
});
