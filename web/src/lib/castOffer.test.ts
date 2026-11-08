import { describe, expect, it, vi } from 'vitest';
import {
  canOfferCast,
  CAST_CONFIG_MS,
  CAST_PLAY_MS,
  castFailureNotice,
  castStateOf,
  fetchCastOrigin,
  returnsFromCast,
} from './castOffer';

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

it('keeps the production config and blank-playback budgets', () => {
  expect(CAST_CONFIG_MS).toBe(6_000);
  expect(CAST_PLAY_MS).toBe(45_000);
});

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

describe('castStateOf', () => {
  it('reads the SDK state, and takes anything else for no receiver', () => {
    expect(castStateOf('NOT_CONNECTED')).toBe('available');
    expect(castStateOf('CONNECTING')).toBe('connecting');
    expect(castStateOf('CONNECTED')).toBe('connected');
    expect(castStateOf('NO_DEVICES_AVAILABLE')).toBe('none');
    expect(castStateOf(undefined)).toBe('none');
    expect(castStateOf('connected'), 'only the SDK’s own spelling').toBe('none');
  });
});

describe('castFailureNotice', () => {
  it('says a receiver went missing apart from one that would not connect, never the code', () => {
    expect(castFailureNotice('receiver_unavailable')).toMatch(
      /^No Chromecast found on this network/,
    );
    for (const code of ['session_error', 'timeout', 'channel_error', 42, undefined])
      expect(castFailureNotice(code)).toBe(
        'Couldn’t connect to the Chromecast. Press Cast to try again.',
      );
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
