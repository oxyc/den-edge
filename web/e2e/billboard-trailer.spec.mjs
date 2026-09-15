// The billboard asking den-reel what to play, rather than building a path and hoping.
//
// What is worth testing here is not that a video appears: it is that this page plays what reel OFFERED,
// in reel's order, and moves down that order when one will not play. Both are things the old code could
// not get wrong because it only ever had one URL, and both are things that have gone wrong since — a
// fallback step that produced the URL already mounted fired no load and no error, and the surface simply
// stopped with nothing to say why.
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
  // Both halves of a link: the play URL every older path was built from, and the sources URL that
  // replaces building anything.
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
}

/** Titles arrive on an event, so the slide is not resolving while the page is still being set up. */
const start = async (page) => {
  await page.goto('http://127.0.0.1:5198/test/billboard.html?reel=1');
  await page.evaluate(() => window.dispatchEvent(new Event('fixture:titles')));
};

test('billboard plays what reel offers, cropped where reel measured it', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mock(page, {
      sources: [{ kind: 'mp4', url: 'http://internal/m/s/chosen.webm', audio: false, height: 720 }],
      crop: { letterboxed: true, aspect: 1.85, rect: [0, 0.0194, 1, 0.9611] },
    });
    await page.route('**/m/s/chosen.webm', serveVideo);
    await start(page);
    const video = page.locator('video.ambient');
    // reel's URL, not one this page built: nothing about `/m/s/chosen` is derivable from the play URL.
    await expect(video).toHaveAttribute('src', 'http://internal/m/s/chosen.webm', {
      timeout: 15000,
    });
    // And the bars are trimmed, rather than drawn inside the hero.
    await expect(video).toHaveAttribute('style', /scale\(1\.04/);
  } finally {
    await browser.close();
  }
});

test('billboard walks reel’s order when the first will not play', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mock(page, {
      sources: [
        { kind: 'mp4', url: 'http://internal/m/s/gone.webm', audio: false, height: 720 },
        { kind: 'mp4', url: 'http://internal/m/s/second.webm', audio: false, height: 720 },
      ],
      crop: null,
    });
    // Withdrawn under us, which is the case reel's ordering exists for.
    await page.route('**/m/s/gone.webm', (r) => r.fulfill({ status: 404 }));
    await page.route('**/m/s/second.webm', serveVideo);
    await start(page);
    const video = page.locator('video.ambient');
    await expect(video).toHaveAttribute('src', 'http://internal/m/s/second.webm', {
      timeout: 15000,
    });
    // An unmeasured trailer draws as it always did, with no transform at all.
    await expect(video).not.toHaveAttribute('style', /scale/);
  } finally {
    await browser.close();
  }
});
