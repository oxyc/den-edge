import { describe, expect, it } from 'vitest';
import { signedMedia } from '../../cast/src/media';

const path = `/remux/s/${'A'.repeat(22)}/${'b'.repeat(22)}/master.m3u8`;

describe('signed media URLs the Cast sender accepts', () => {
  it('takes a signed playlist on an IPv4 or IPv6 literal', () => {
    expect(signedMedia(`https://203.0.113.7${path}`)).toBe(true);
    expect(signedMedia(`https://[2001:db8::7]${path}`)).toBe(true);
  });

  it('takes a signed playlist on a dotted DNS name', () => {
    expect(signedMedia(`https://a7f3k9x2.media.example${path}`)).toBe(true);
    expect(signedMedia(`https://Media.Example.com${path}`)).toBe(true);
  });

  it('refuses a single-label or malformed host', () => {
    expect(signedMedia(`https://localhost${path}`)).toBe(false);
    expect(signedMedia(`https://intranet${path}`)).toBe(false);
    expect(signedMedia(`https://-bad.example${path}`)).toBe(false);
  });

  it('still refuses plain http, another path, and something that is not a URL', () => {
    expect(signedMedia(`http://203.0.113.7${path}`)).toBe(false);
    expect(signedMedia(`http://media.example${path}`)).toBe(false);
    expect(signedMedia('https://203.0.113.7/remux/s/short/short/master.m3u8')).toBe(false);
    expect(signedMedia('https://media.example/other/master.m3u8')).toBe(false);
    expect(signedMedia('not a url')).toBe(false);
  });
});
