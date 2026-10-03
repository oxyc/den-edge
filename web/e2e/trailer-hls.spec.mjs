// A title's trailer through hls.js, where the browser plays no HLS itself. Each fragment is fetched once: the hero
// once asked hls.js for a level switch on every buffered fragment, and each switch threw away what was buffered
// ahead and fetched it again — one segment 830 times in four seconds, ~2,700 requests, on a desktop browser.
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

const hls = new URL('./media/hls/', import.meta.url);
const master = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
  'low/media.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
  'high/media.m3u8',
  '',
].join('\n');

test('a trailer played through hls.js fetches each fragment once', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await guardNetwork(page);
  await routeTmdb(page, (r) =>
    r.fulfill({
      json: {
        id: 42,
        imdb_id: 'tt42',
        title: 'The Movie',
        poster_path: '/poster.jpg',
        backdrop_path: '/backdrop.jpg',
      },
    }),
  );
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"/>',
    }),
  );
  await page.route('**/reel/fixture/meta/**', (r) =>
    r.fulfill({
      json: {
        meta: {
          links: [
            {
              trailers: 'http://internal/play/trailer.webm',
              sources: 'http://internal/sources/trailer.json',
            },
          ],
        },
      },
    }),
  );
  await page.route('**/sources/trailer.json**', (r) =>
    r.fulfill({
      json: {
        sources: [{ kind: 'hls', url: 'http://internal/m/s/master.m3u8', audio: true }],
        crop: null,
      },
    }),
  );
  const asked = new Map();
  await page.route('**/m/s/**', async (r) => {
    const path = new URL(r.request().url()).pathname;
    asked.set(path, (asked.get(path) ?? 0) + 1);
    if (path.endsWith('/master.m3u8'))
      return r.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: master });
    const file = path.split('/').pop();
    return r.fulfill({
      contentType: file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      body: await readFile(new URL(file, hls)),
    });
  });
  await page.goto(`${E2E_ORIGIN}/test/detail-trailer.html`);
  const video = page.locator('[data-detail-media] video');
  await expect(video).toHaveClass(/\bplaying\b/, { timeout: 15000 });
  // A few seconds of playing, in which a loop would have asked thousands of times.
  await page.waitForTimeout(4000);
  const fragments = [...asked].filter(([path]) => path.endsWith('.m4s'));
  expect(fragments.length).toBeGreaterThan(0);
  expect(fragments.filter(([, n]) => n > 1)).toEqual([]);
});
