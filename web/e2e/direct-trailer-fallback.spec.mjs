// Direct (public) trailers when the direct origin cannot be reached (oxyc/den#197).
//
// At home the router does not loop the household's own public address back in, so a direct URL never answers —
// and iOS's native player waited on it with no error, so nothing played. Two things hold that still: a direct copy
// that has shown no frame within DIRECT_FIRST_FRAME_MS gives way to its relay copy, in Chromium and in WebKit; and
// where den-edge says the browser is at home (`409 at_home`) the direct origin is never asked at all.
//
// "Unreachable" is a request that is never answered, which is what a dropped connection looks like to the element:
// no `error`, just waiting.
import { test, expect, chromium, webkit } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { guardNetwork, routeTmdb } from './network.mjs';

const videoBytes = await readFile(new URL('./media/trailer.webm', import.meta.url));
const ORIGIN = 'http://127.0.0.1:5198';
const DIRECT = 'https://media.invalid';
const BLOB = 'A'.repeat(40);
const TAG = 'b'.repeat(24);
const RELAY_URL = `/reel/m/s/${BLOB}?s=${TAG}`;
/** reel's `DIRECT_FIRST_FRAME_MS`, which these hold the page to. */
const DEADLINE_MS = 2_000;

const movie = {
  id: 42,
  imdb_id: 'tt42',
  title: 'The Movie',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  overview: 'The description belongs below the title.',
  genres: [{ name: 'Drama' }],
};

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

/**
 * reel answering one signed carried source, the relay serving it, and den-edge answering activation with
 * `activation`: `open` (200, the direct origin then never answers) or `home` (409 at_home).
 */
async function mock(page, activation) {
  const seen = { activations: 0, direct: 0 };
  await guardNetwork(page);
  await routeTmdb(page, (r) => r.fulfill({ json: movie }));
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
  await page.route('**/sources/trailer.json**', (r) =>
    r.fulfill({
      json: {
        sources: [
          { kind: 'mp4', url: `http://internal/m/s/${BLOB}?s=${TAG}`, audio: true, height: 720 },
        ],
      },
    }),
  );
  await page.route(`${ORIGIN}/reel/activate`, (r) => {
    seen.activations += 1;
    return activation === 'home'
      ? r.fulfill({ status: 409, json: { error: 'at_home' } })
      : r.fulfill({
          json: { publicBase: DIRECT, media: `${DIRECT}${RELAY_URL}`, form: 'progressive' },
        });
  });
  await page.route(
    (url) => url.origin === ORIGIN && url.pathname.startsWith('/reel/m/s/'),
    serveVideo,
  );
  // Never answered: a router that drops the connection, as the one at home does for its own public address.
  await page.route(`${DIRECT}/**`, () => {
    seen.direct += 1;
  });
  return seen;
}

const engines = [
  [
    'chromium',
    () => chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }),
  ],
  // WebKit is Safari's and iOS's engine, the one that waited. CI installs only Chromium, so it runs where present.
  ['webkit', () => webkit.launch(), () => existsSync(webkit.executablePath())],
];

const surfaces = [
  {
    name: 'hero',
    open: (page) => page.goto(`${ORIGIN}/test/detail-trailer.html`),
    video: '[data-detail-media] video',
  },
  {
    name: 'billboard',
    open: async (page) => {
      await page.goto(`${ORIGIN}/test/billboard.html?reel=1`);
      await page.evaluate(() => window.dispatchEvent(new Event('fixture:titles')));
    },
    video: 'video.ambient',
  },
];

/** Milliseconds from opening the surface until its trailer is playing, and what played. */
async function timeToPlay(launch, surface, activation) {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const seen = await mock(page, activation);
    const began = Date.now();
    await surface.open(page);
    const video = page.locator(surface.video);
    await expect(video).toHaveClass(/playing/, { timeout: 15_000 });
    const took = Date.now() - began;
    return { took, src: await video.getAttribute('src'), seen };
  } finally {
    await browser.close();
  }
}

for (const [engine, launch, available = () => true] of engines) {
  for (const surface of surfaces) {
    test(`${engine} ${surface.name}: an unreachable direct origin gives way to the relay within the deadline`, async () => {
      test.skip(!available(), `${engine} is not installed here`);
      const home = await timeToPlay(launch, surface, 'home');
      const away = await timeToPlay(launch, surface, 'open');
      // At home: asked once, refused, and the direct origin never touched.
      expect(home.seen).toEqual({ activations: 1, direct: 0 });
      expect(home.src).toBe(RELAY_URL);
      // Unreachable: the direct copy was mounted, then the relay copy played.
      expect(away.seen.activations).toBe(1);
      expect(away.seen.direct).toBeGreaterThan(0);
      expect(away.src).toBe(RELAY_URL);
      test.info().annotations.push({
        type: 'time to playing',
        description: `${engine} ${surface.name}: relay-only ${home.took} ms, direct unreachable ${away.took} ms`,
      });
      // The deadline and no more: what the relay would have taken anyway, plus the wait for a first frame.
      expect(away.took).toBeLessThan(home.took + DEADLINE_MS + 1_500);
    });
  }
}
