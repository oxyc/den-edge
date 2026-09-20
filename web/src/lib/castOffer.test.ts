import { describe, expect, it } from 'vitest';
import { canOfferCast } from './castOffer';

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36';
const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const CHROME_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/153.0.0.0 Mobile/15E148 Safari/604.1';
const FIREFOX =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:150.0) Gecko/20100101 Firefox/150.0';

describe('canOfferCast', () => {
  it('is true where the Cast SDK exists: desktop and Android Chromium', () => {
    expect(canOfferCast(CHROME_MAC)).toBe(true);
    expect(canOfferCast(EDGE)).toBe(true);
    expect(canOfferCast(ANDROID_CHROME)).toBe(true);
  });

  it('is false in Safari, Firefox and every iOS browser, which have no Cast sender', () => {
    expect(canOfferCast(SAFARI_MAC)).toBe(false);
    expect(canOfferCast(SAFARI_IPHONE)).toBe(false);
    expect(canOfferCast(CHROME_IPHONE), 'Chrome on iOS is WebKit').toBe(false);
    expect(canOfferCast(FIREFOX)).toBe(false);
  });

  it('is false for no user agent at all', () => {
    expect(canOfferCast('')).toBe(false);
  });
});
