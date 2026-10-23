import { describe, expect, it } from 'vitest';
import { deviceOf, entryOf, loadRouteOf, loadSettled, MILESTONES, netTally } from './loadReport';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_MODE =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const LG_WEBOS =
  'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36 WebAppManager';
const ANDROID_TV_SHELL =
  'Mozilla/5.0 (Linux; Android 12; BRAVIA 4K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 DenAndroidTV/1.4';

describe('deviceOf', () => {
  it('names every iPhone browser a WebKit phone, whatever it calls itself', () => {
    expect(deviceOf(IPHONE_SAFARI)).toEqual({ device: 'phone', engine: 'webkit' });
    expect(deviceOf(IPHONE_CHROME)).toEqual({ device: 'phone', engine: 'webkit' });
  });

  it('tells an iPad asking for desktop pages from a Mac by its touch points', () => {
    expect(deviceOf(IPAD_DESKTOP_MODE, 5)).toEqual({ device: 'tablet', engine: 'webkit' });
    expect(deviceOf(IPAD_DESKTOP_MODE, 0)).toEqual({ device: 'desktop', engine: 'webkit' });
  });

  it('names Chrome on a desktop and on Android', () => {
    expect(deviceOf(MAC_CHROME)).toEqual({ device: 'desktop', engine: 'blink' });
    expect(deviceOf(ANDROID_CHROME)).toEqual({ device: 'phone', engine: 'blink' });
  });

  it('names a TV a TV, not the desktop or tablet its browser otherwise reads as', () => {
    expect(deviceOf(LG_WEBOS)).toEqual({ device: 'tv', engine: 'blink' });
    expect(deviceOf(ANDROID_TV_SHELL)).toEqual({ device: 'tv', engine: 'blink' });
  });
});

describe('loadRouteOf', () => {
  it('names the kind of page, never the page', () => {
    expect(loadRouteOf('/')).toBe('home');
    expect(loadRouteOf('/series')).toBe('series');
    expect(loadRouteOf('/watchlist')).toBe('watchlist');
    expect(loadRouteOf('/tv/1399-game-of-thrones')).toBe('title');
    expect(loadRouteOf('/settings')).toBe('settings');
    expect(loadRouteOf('/search?q=blade+runner')).toBe('other');
  });
});

describe('entryOf', () => {
  const page = 'https://d.oxy.fi/tv/90282-the-morning-show';
  it('tells Den’s own release swap from a load the browser made', () => {
    expect(entryOf({ type: 'navigate', name: `${page}?den-retry=m4k2` })).toBe('swap');
    expect(entryOf({ type: 'navigate', name: page })).toBe('navigate');
    expect(entryOf({ type: 'reload', name: page })).toBe('reload');
    expect(entryOf({ type: 'back_forward', name: page })).toBe('back_forward');
  });

  it('sends nothing it does not know', () => {
    expect(entryOf(undefined)).toBeUndefined();
    expect(entryOf({ type: 'prerender', name: page })).toBeUndefined();
  });
});

describe('netTally', () => {
  it('counts and sums the page’s requests by kind, never naming one', () => {
    const tally = netTally([
      { name: 'https://den-tv.oxy.fi/tmdb/3/movie/550', initiatorType: 'fetch', duration: 210.4 },
      { name: 'https://den-tv.oxy.fi/tmdb/3/tv/1399', initiatorType: 'fetch', duration: 190.2 },
      { name: 'https://den-tv.oxy.fi/lib/abc/changes', initiatorType: 'fetch', duration: 80 },
      {
        name: 'https://den-tv.oxy.fi/ratings/movie/tt1',
        initiatorType: 'xmlhttprequest',
        duration: 40,
      },
      { name: 'https://image.tmdb.org/t/p/w342/x.jpg', initiatorType: 'img', duration: 300 },
      { name: 'https://den-tv.oxy.fi/assets/index.js', initiatorType: 'script', duration: 500 },
    ]);
    expect(tally).toEqual({ tmdb: [2, 400], lib: [1, 80], meta: [1, 40], image: [1, 300] });
  });
});

describe('loadSettled', () => {
  const at = (events: Record<string, number>) => (event: string) => events[event];

  it('waits for content, and for a first library read that has started', () => {
    expect(loadSettled(at({}))).toBe(false);
    expect(loadSettled(at({ [MILESTONES.posterMs]: 900 }))).toBe(true);
    expect(loadSettled(at({ [MILESTONES.posterMs]: 900, [MILESTONES.importStartMs]: 100 }))).toBe(
      false,
    );
    expect(
      loadSettled(
        at({
          [MILESTONES.posterMs]: 900,
          [MILESTONES.importStartMs]: 100,
          [MILESTONES.importMs]: 118_000,
        }),
      ),
    ).toBe(true);
  });

  it('waits on Home for its shelves, which can follow its first poster by seconds', () => {
    expect(loadSettled(at({ [MILESTONES.posterMs]: 900 }), 'home')).toBe(false);
    expect(
      loadSettled(at({ [MILESTONES.posterMs]: 900, [MILESTONES.shelvesMs]: 13_000 }), 'home'),
    ).toBe(true);
    expect(loadSettled(at({ [MILESTONES.posterMs]: 900 }), 'title')).toBe(true);
  });
});
