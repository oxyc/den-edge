import { describe, expect, it, vi } from 'vitest';
import { canOfferCast, castLook, fetchCastOrigin, returnsFromCast } from './castOffer';

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

describe('castLook', () => {
  it('moves playback only once a receiver is seen', () => {
    expect(castLook('looking', { kind: 'availability', available: true })).toEqual({
      offer: 'idle',
      move: true,
    });
  });

  it('keeps looking on "no devices", which the Cast SDK says before it has looked', () => {
    expect(castLook('looking', { kind: 'availability', available: false })).toEqual({
      offer: 'looking',
      move: false,
    });
  });

  it('finds none at the deadline, or with no cast page, and moves nothing', () => {
    expect(castLook('looking', { kind: 'deadline' })).toEqual({ offer: 'none', move: false });
    expect(castLook('looking', { kind: 'no-cast-page' })).toEqual({ offer: 'none', move: false });
  });

  it('ignores answers that arrive when nobody is looking', () => {
    expect(castLook('idle', { kind: 'availability', available: true })).toEqual({
      offer: 'idle',
      move: false,
    });
    expect(castLook('none', { kind: 'availability', available: true })).toEqual({
      offer: 'none',
      move: false,
    });
    expect(castLook('idle', { kind: 'deadline' })).toEqual({ offer: 'idle', move: false });
  });
});

describe('returnsFromCast', () => {
  it('takes a failed cast-page session back to the player it left, unless a receiver has it', () => {
    expect(returnsFromCast(true, false)).toBe(true);
    expect(returnsFromCast(true, true), 'a receiver keeps its conservative retry').toBe(false);
    expect(returnsFromCast(false, false), 'the page never left the cast page').toBe(false);
  });
});

describe('fetchCastOrigin', () => {
  const answering = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('reads the cast page origin from /config', async () => {
    expect(await fetchCastOrigin(answering({ castOrigin: 'https://cast.example' }))).toBe(
      'https://cast.example',
    );
  });

  it('is null where casting is off, or the answer is not a bare https origin', async () => {
    expect(await fetchCastOrigin(answering({}))).toBeNull();
    expect(await fetchCastOrigin(answering({ castOrigin: 'http://cast.example' }))).toBeNull();
    expect(await fetchCastOrigin(answering({ castOrigin: 'https://cast.example/x' }))).toBeNull();
    expect(
      await fetchCastOrigin(answering({ castOrigin: 'https://cast.example' }, 500)),
    ).toBeNull();
  });

  it('is null when /config cannot be reached', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = (async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    expect(await fetchCastOrigin(failing)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
