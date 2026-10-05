// A guest never opens Settings, so Settings' subtitle language is always unset for them — and den-remux always
// offers a rendition in whatever the browser's own languages are (or den-remux#<pending>'s "und" fallback) and in
// English, right behind the viewer's own first choice (`subs::plan`). Before `autoSubtitleLanguage`
// (web/src/lib/remux.ts), nothing ever turned one of those renditions on by itself: a foreign-audio title played
// with no subtitle at all unless the viewer found the picker themselves (oxyc/den-edge#<pending>, "Fauda S1E3").
//
// WebKit is what an iPhone plays HLS through — natively, with no hls.js in the way (`nativeHls.ts`: any WebKit
// browser, not only Safari's own UA) — so this is the engine whose own `<video>`.textTracks the fix has to drive.
import { test, expect, webkit } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

const ORIGIN = E2E_ORIGIN;
const hls = new URL('./media/hls/', import.meta.url);
const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:30.000\nHello.\n';
// An iPhone's own WebKit build: `nativeHls.ts` gates on `navigator.vendor`, not the viewport, so this UA is
// what actually matters — Playwright's `devices['iPhone …']` sets `isMobile`, which triggered unrelated
// network probing here; a plain context with this UA is what an iPhone's Safari or Chrome sends, either way.
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
  'Version/18.0 Mobile/15E148 Safari/604.1';

/** Fauda S1E3's own shape: Hebrew audio, no Swedish rendition anywhere, English the only one offered. */
const foreignAudioSession = {
  sid: 's1',
  playlist: '/direct/s/s1/sig/master.m3u8',
  duration: 60,
  release: { label: 'Fixture 1080p', filename: 'fixture.mkv', size: 1 },
  video: { codec: 'h264', transcoded: false },
  audioTrack: 0,
  audioTracks: [{ language: 'heb', name: null, channels: 2, commentary: false }],
  subtitles: [{ language: 'en', name: 'English' }],
};
/** Audio already in the viewer's own language: `autoSubtitleLanguage` turns nothing on by itself here, so a
 * rendition showing is only ever the viewer's own doing. */
const ownLanguageAudioSession = {
  ...foreignAudioSession,
  audioTracks: [{ language: 'eng', name: null, channels: 2, commentary: false }],
};

/** Exactly what `playlist::master` writes for a subtitle rendition: DEFAULT=NO, never auto-selected by the
 * engine itself — the fix has to turn it on through `video.textTracks`, not rely on the playlist alone. */
const master = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="sub0.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,AVERAGE-BANDWIDTH=1000000,CODECS="avc1.64001f,mp4a.40.2",SUBTITLES="subs"
media.m3u8
`;
const subMedia = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:60
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:60.0,
sub0.vtt
#EXT-X-ENDLIST
`;

async function mockSession(page, session = foreignAudioSession) {
  await guardNetwork(page);
  await routeTmdb(page, (r) => r.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (r) => r.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (r) => r.fulfill({ json: {} }));
  await page.route(`${ORIGIN}/direct/session`, (r) => r.fulfill({ status: 201, json: session }));
  await page.route(`${ORIGIN}/direct/releases`, (r) => r.fulfill({ json: { releases: [] } }));
  await page.route(`${ORIGIN}/direct/s/**`, async (r) => {
    const request = r.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'DELETE') return r.fulfill({ status: 204 });
    if (request.method() === 'POST') return r.fulfill({ status: 204 });
    const name = path.split('/').pop();
    if (name === 'master.m3u8')
      return r.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: master });
    if (name === 'sub0.m3u8')
      return r.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: subMedia });
    if (name === 'sub0.vtt') return r.fulfill({ contentType: 'text/vtt', body: vtt });
    return r.fulfill({
      contentType: name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      body: await readFile(new URL(name, hls)),
    });
  });
}

/** The showing text track's language, or null: whichever `video.textTracks` has `mode === 'showing'`. */
function shownLanguage() {
  const video = document.querySelector('.player video');
  for (const track of video?.textTracks ?? []) if (track.mode === 'showing') return track.language;
  return null;
}

test.describe('a guest whose browser is Swedish and never set a subtitle language', () => {
  test.skip(!existsSync(webkit.executablePath()), 'WebKit is not installed here');

  test('shows the release’s only rendition — English — without being asked', async () => {
    const browser = await webkit.launch();
    try {
      const context = await browser.newContext({ userAgent: IPHONE_UA, locale: 'sv-SE' });
      const page = await context.newPage();
      await mockSession(page);
      await page.goto(`${ORIGIN}/test/player.html`);
      await page.waitForFunction(
        () => (document.querySelector('.player video')?.currentTime ?? 0) > 1,
        undefined,
        { timeout: 30_000 },
      );
      await expect.poll(() => page.evaluate(shownLanguage), { timeout: 10_000 }).toBe('en');
    } finally {
      await browser.close();
    }
  });

  test('also shows English when the viewer picks it from the menu themselves', async () => {
    const browser = await webkit.launch();
    try {
      // Audio already in a language this browser names: `autoSubtitleLanguage` turns nothing on here, so
      // this test is really exercising the menu, not the fix above under another name.
      const context = await browser.newContext({ userAgent: IPHONE_UA, locale: 'en-US' });
      const page = await context.newPage();
      await mockSession(page, ownLanguageAudioSession);
      await page.goto(`${ORIGIN}/test/player.html`);
      await page.waitForFunction(
        () => (document.querySelector('.player video')?.currentTime ?? 0) > 1,
        undefined,
        { timeout: 30_000 },
      );
      expect(await page.evaluate(shownLanguage)).toBeNull();
      await page.getByLabel('Subtitles').selectOption('en');
      await expect.poll(() => page.evaluate(shownLanguage), { timeout: 10_000 }).toBe('en');
    } finally {
      await browser.close();
    }
  });
});
