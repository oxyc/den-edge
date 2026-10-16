// The managed path uses the same player on browsers with native HLS (Apple platforms) and hls.js. Hearth returns
// only a media URL; neither Den's request credentials nor a Remux lifecycle may follow that URL to the CDN.
import { test, expect, chromium, webkit } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const hls = new URL('./media/hls/', import.meta.url);
const CDN = 'https://flux-002.wnam.tb-cdn.io/opaque';
const release = { label: 'Managed 1080p', filename: 'managed.mkv', size: 1 };

async function mockManagedPlayer(page) {
  await guardNetwork(page);
  await routeTmdb(page, (route) => route.fulfill({ json: { imdb_id: 'tt42' } }));
  await page.route(`${ORIGIN}/skipdb/**`, (route) => route.fulfill({ status: 404, json: {} }));
  await page.route(`${ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
  await page.route(`${ORIGIN}/den/config/subtitles/**`, (route) =>
    route.fulfill({ json: { subtitles: [] } }),
  );
  const playback = [];
  await page.route(`${ORIGIN}/den/config/playback`, (route) => {
    playback.push(route.request());
    return route.fulfill({
      headers: { 'cache-control': 'no-store' },
      json: { url: `${CDN}/master.m3u8`, release },
    });
  });
  const media = [];
  await page.route(`${CDN}/**`, async (route) => {
    const request = route.request();
    media.push(request);
    const name = new URL(request.url()).pathname.split('/').pop();
    const file = name === 'master.m3u8' ? 'media.m3u8' : name;
    return route.fulfill({
      headers: {
        'access-control-allow-origin': ORIGIN,
        'content-type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      },
      body: await readFile(new URL(file, hls)),
    });
  });
  let legacySessions = 0;
  await page.route(`${ORIGIN}/direct/session`, (route) => {
    legacySessions += 1;
    return route.fulfill({ status: 500 });
  });
  await page.route(`${ORIGIN}/direct/releases`, (route) =>
    route.fulfill({ json: { releases: [] } }),
  );
  await page.route(`${ORIGIN}/playback/outcome`, (route) => route.fulfill({ status: 204 }));
  return { playback, media, legacySessions: () => legacySessions };
}

for (const [name, browserType, available] of [
  ['hls.js', chromium, true],
  ['WebKit native HLS', webkit, existsSync(webkit.executablePath())],
]) {
  test(`managed direct HLS stays one operation and credential-free on ${name}`, async () => {
    test.skip(!available, `${name} is not installed here`);
    const browser = await browserType.launch({
      ...(browserType === chromium ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {}),
    });
    try {
      const context = await browser.newContext();
      await context.addCookies([{ name: 'den-session', value: 'secret', url: ORIGIN }]);
      const page = await context.newPage();
      const seen = await mockManagedPlayer(page);
      await page.goto(
        `${ORIGIN}/test/player.html?playback=${encodeURIComponent('/den/config/playback')}`,
      );
      await expect.poll(() => seen.playback.length, { timeout: 10_000 }).toBe(1);
      await expect.poll(() => seen.media.length, { timeout: 20_000 }).toBeGreaterThan(1);

      expect(seen.playback).toHaveLength(1);
      const start = seen.playback[0];
      expect(start.method()).toBe('POST');
      expect(start.headers()['idempotency-key']).toBeTruthy();
      expect(JSON.parse(start.postData() ?? '{}')).not.toHaveProperty('directFailed');
      expect(seen.legacySessions()).toBe(0);
      expect(seen.media.length).toBeGreaterThan(1);
      for (const request of seen.media) {
        const headers = request.headers();
        expect(headers).not.toHaveProperty('x-den-library-member');
        expect(headers).not.toHaveProperty('x-den-grant');
        expect(headers).not.toHaveProperty('idempotency-key');
        expect(headers).not.toHaveProperty('cookie');
      }

      await page.getByRole('button', { name: 'Close' }).click();
      expect(seen.playback).toHaveLength(1);
      expect(seen.legacySessions()).toBe(0);
    } finally {
      await browser.close();
    }
  });
}
