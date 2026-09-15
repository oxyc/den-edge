// The detail hero asking den-reel what to play, rather than deriving it from the play URL.
//
// The existing detail-trailer spec answers /meta with a play URL and no sources URL, so it proves the
// legacy derivation still works and covers none of this. What is worth holding still here is that the
// hero ADOPTS reel's answer — a minted URL is not derivable from the play URL by any rule, so asserting
// one can only be satisfied by having asked — and that it walks reel's order when an entry will not play.
import { test, expect, chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { guardNetwork } from './network.mjs';

const videoBytes = await readFile(new URL('./media/trailer.webm', import.meta.url));
const movie = {
  id: 42,
  imdb_id: 'tt42',
  title: 'The Movie',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  overview: 'The description belongs below the title.',
  genres: [{ name: 'Drama' }],
};

/** reel's media, served with ranges, since a `<video>` opens one and cannot seek without them. */
const serveVideo = (route) => {
  const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Number(range[2]) : videoBytes.length - 1;
  return route.fulfill({
    status: range ? 206 : 200,
    contentType: 'video/webm',
    body: videoBytes.subarray(start, end + 1),
    headers: {
      'accept-ranges': 'bytes',
      ...(range ? { 'content-range': `bytes ${start}-${end}/${videoBytes.length}` } : {}),
    },
  });
};

async function mock(page, sources) {
  await guardNetwork(page);
  await page.route('https://api.themoviedb.org/**', (r) => r.fulfill({ json: movie }));
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="blue"/></svg>',
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
  await page.route('**/sources/trailer.json**', (r) => r.fulfill({ json: sources }));
  // The derived master is mounted first and replaced by reel's answer; it must not 404 into the ladder.
  await page.route('**/hls/trailer.m3u8**', (r) => r.fulfill({ status: 204, body: '' }));
  await page.route('**/play/trailer.webm', serveVideo);
}

const open = (page) => page.goto('http://127.0.0.1:5198/test/detail-trailer.html');

test('hero adopts reel’s source and crop', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mock(page, {
      sources: [{ kind: 'mp4', url: 'http://internal/m/s/chosen.webm', audio: true, height: 1080 }],
      crop: { letterboxed: true, aspect: 1.85, rect: [0, 0.0194, 1, 0.9611] },
    });
    await page.route('**/m/s/chosen.webm', serveVideo);
    await open(page);
    const video = page.locator('[data-detail-media] video');
    // Not derivable from the play URL: this can only have come from reel's answer.
    await expect(video).toHaveAttribute('src', 'http://internal/m/s/chosen.webm', {
      timeout: 15000,
    });
    await expect(video).toHaveAttribute('style', /scale\(1\.04/);
  } finally {
    await browser.close();
  }
});

test('hero walks reel’s order when an entry will not play', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mock(page, {
      sources: [
        { kind: 'mp4', url: 'http://internal/m/s/gone.webm', audio: true, height: 1080 },
        { kind: 'mp4', url: 'http://internal/m/s/second.webm', audio: true, height: 720 },
      ],
      crop: null,
    });
    await page.route('**/m/s/gone.webm', (r) => r.fulfill({ status: 404 }));
    await page.route('**/m/s/second.webm', serveVideo);
    await open(page);
    const video = page.locator('[data-detail-media] video');
    await expect(video).toHaveAttribute('src', 'http://internal/m/s/second.webm', {
      timeout: 15000,
    });
    // Unmeasured: drawn exactly as it was before any of this, which is every trailer's first view.
    await expect(video).not.toHaveAttribute('style', /scale/);
  } finally {
    await browser.close();
  }
});
