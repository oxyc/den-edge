import { describe, expect, it } from 'vitest';
import { signedMedia } from '../../cast/src/media';

const path = `/remux/s/${'A'.repeat(22)}/${'b'.repeat(22)}/master.m3u8`;
const domains = ['481920.xyz'];

describe('signed media URLs the Cast sender accepts', () => {
  it('takes a signed playlist on an IPv4 or IPv6 literal', () => {
    expect(signedMedia(`https://203.0.113.7${path}`)).toBe(true);
    expect(signedMedia(`https://[2001:db8::7]${path}`)).toBe(true);
  });

  it('takes a label under a media domain, but not the apex or a lookalike', () => {
    expect(signedMedia(`https://a7f3k9x2.481920.xyz${path}`, domains)).toBe(true);
    expect(signedMedia(`https://481920.xyz${path}`, domains)).toBe(false);
    expect(signedMedia(`https://a7f3k9x2.481920.xyz.evil.example${path}`, domains)).toBe(false);
    expect(signedMedia(`https://evil481920.xyz${path}`, domains)).toBe(false);
  });

  it('takes no name when no domain is configured', () => {
    expect(signedMedia(`https://a7f3k9x2.481920.xyz${path}`)).toBe(false);
  });

  it('still refuses plain http, another path, and a name off every domain', () => {
    expect(signedMedia(`http://203.0.113.7${path}`)).toBe(false);
    expect(signedMedia('https://203.0.113.7/remux/s/short/short/master.m3u8')).toBe(false);
    expect(signedMedia(`https://media.example.com${path}`, domains)).toBe(false);
    expect(signedMedia('not a url', domains)).toBe(false);
  });
});
