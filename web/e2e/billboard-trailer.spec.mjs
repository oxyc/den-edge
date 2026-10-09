// The billboard asking den-reel what to play, rather than building a path and hoping.
//
// What is worth testing here is not that a video appears: it is that this page plays what reel OFFERED,
// in reel's order, and moves down that order when one will not play. Both are things the old code could
// not get wrong because it only ever had one URL, and both are things that have gone wrong since — a
// fallback step that produced the URL already mounted fired no load and no error, and the surface simply
// stopped with nothing to say why.
import { test, expect, chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

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

const EXPIRES = 2_000_000_000;

/** Stable opaque capabilities let each assertion name its fixture without pretending the name is a media URL. */
const capabilityFor = (media) => {
  const name = new URL(media).pathname.split('/').at(-1) ?? 'media';
  const blob = name
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .padEnd(40, '_')
    .slice(0, 40);
  const signature = Buffer.from(name).toString('hex').padEnd(24, '0').slice(0, 24);
  return `m/s/${blob}?s=${signature}`;
};

const relayUrl = (media) => `/reel/${capabilityFor(media)}`;

const sourcePlan = ({ sources, crop = null }) => ({
  v: 2,
  expires: EXPIRES,
  crop,
  sources: sources.map(({ url, ...source }) => ({
    ...source,
    delivery: url.startsWith('http://internal/')
      ? { type: 'reel', capability: capabilityFor(url) }
      : { type: 'external', url },
  })),
});

const planUrl = (id) => `http://internal/sources/${id}.json?v=2`;

const prepareAnswer = (id, plan) => ({
  v: 2,
  meta: { links: [{ planUrl: planUrl(id) }] },
  primary: { id, planUrl: planUrl(id) },
  primaryPlan: sourcePlan(plan),
});

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

async function mock(page, plan, prepared) {
  const counts = { currentPrepare: 0, nextPrepare: 0, transport: 0 };
  await guardNetwork(page);
  await routeTmdb(page, (r) => r.fulfill({ json: movie }));
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="blue"/></svg>',
    }),
  );
  // Reel v2 discovers logical sources in a versioned plan. Reel-carried entries expose only an opaque
  // capability; Edge chooses its ordered network transports when the cursor reaches that entry.
  await page.route('**/reel/fixture/prepare/**', (r) => {
    const current = r.request().url().includes('tmdb:42');
    const next = r.request().url().includes('tmdb:43');
    if (current) {
      counts.currentPrepare += 1;
      return r.fulfill({ json: prepared ?? prepareAnswer('trailer', plan) });
    }
    if (next) {
      counts.nextPrepare += 1;
      return r.fulfill({
        json: prepareAnswer('next', {
          sources: [
            {
              kind: 'mp4',
              url: 'https://rr3---sn-x.googlevideo.com/next',
              audio: false,
              height: 720,
            },
          ],
        }),
      });
    }
    return r.fulfill({ status: 404, json: {} });
  });

  await page.route('**/reel/transport', async (r) => {
    counts.transport += 1;
    const { capability } = r.request().postDataJSON();
    return r.fulfill({
      json: {
        v: 2,
        capability,
        attempts: [{ type: 'relay', url: `/reel/${capability}` }],
      },
    });
  });
  return counts;
}

const routeMedia = (page, media, handler) =>
  page.route((url) => `${url.pathname}${url.search}` === relayUrl(media), handler);

/** Titles arrive on an event, so the slide is not resolving while the page is still being set up. */
const start = async (page) => {
  await page.goto(`${E2E_ORIGIN}/test/billboard.html?reel=1`);
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
    await routeMedia(page, 'http://internal/m/s/chosen.webm', serveVideo);
    await start(page);
    const video = page.locator('video.ambient');
    // Reel's capability, not a URL this page inferred from an older play link. Edge's transport answer
    // mounts that capability on the relay origin selected for this browser.
    await expect(video).toHaveAttribute('src', relayUrl('http://internal/m/s/chosen.webm'), {
      timeout: 15000,
    });
    // And the bars are trimmed, rather than drawn inside the hero.
    await expect(video).toHaveAttribute('style', /scale\(1\.04/);
  } finally {
    await browser.close();
  }
});

test('an inactive retained billboard unloads its media resource before it can retry', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.fixtureMediaLoads = 0;
    const load = HTMLMediaElement.prototype.load;
    HTMLMediaElement.prototype.load = function () {
      window.fixtureMediaLoads += 1;
      return load.call(this);
    };
  });
  await mock(page, {
    sources: [{ kind: 'mp4', url: 'http://internal/m/s/chosen.webm', audio: false, height: 720 }],
  });
  await routeMedia(page, 'http://internal/m/s/chosen.webm', serveVideo);
  await start(page);
  const video = page.locator('video.ambient');
  await expect(video).toHaveClass(/\bplaying\b/, { timeout: 15_000 });
  const loadsBefore = await page.evaluate(() => window.fixtureMediaLoads);

  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('fixture:active', { detail: false })),
  );
  await expect
    .poll(() =>
      video.evaluate((element) => ({
        attribute: element.getAttribute('src'),
        paused: element.paused,
      })),
    )
    .toEqual({ attribute: null, paused: true });
  await expect(video).not.toHaveClass(/\bplaying\b/);
  expect(await page.evaluate(() => window.fixtureMediaLoads)).toBeGreaterThan(loadsBefore);

  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('fixture:active', { detail: true })),
  );
  await expect(video).toHaveAttribute('src', relayUrl('http://internal/m/s/chosen.webm'));
  await expect(video).toHaveClass(/\bplaying\b/, { timeout: 15_000 });
  await expect.poll(() => video.evaluate((element) => !element.paused)).toBe(true);
});

test('equal title republishes do not restart the same ambient trailer request', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const counts = await mock(page, {
      sources: [{ kind: 'mp4', url: 'http://internal/m/s/chosen.webm', audio: false, height: 720 }],
    });
    await routeMedia(page, 'http://internal/m/s/chosen.webm', serveVideo);
    await start(page);
    await expect(page.locator('video.ambient')).toHaveAttribute(
      'src',
      relayUrl('http://internal/m/s/chosen.webm'),
      { timeout: 15000 },
    );

    await page.evaluate(async () => {
      for (let n = 0; n < 3; n += 1) {
        window.dispatchEvent(new Event('fixture:republish'));
        await new Promise((resolve) => setTimeout(resolve, 650));
      }
    });

    expect(counts.transport).toBe(1);
  } finally {
    await browser.close();
  }
});

test('equal title republishes do not restart the next trailer prewarm', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const counts = await mock(page, {
      sources: [{ kind: 'mp4', url: 'http://internal/m/s/chosen.webm', audio: false, height: 720 }],
    });
    await routeMedia(page, 'http://internal/m/s/chosen.webm', serveVideo);
    await start(page);
    await expect(page.locator('video.ambient')).toHaveAttribute(
      'src',
      relayUrl('http://internal/m/s/chosen.webm'),
      { timeout: 15000 },
    );
    await expect.poll(() => counts.nextPrepare).toBe(1);

    await page.evaluate(async () => {
      for (let n = 0; n < 3; n += 1) {
        window.dispatchEvent(new Event('fixture:republish'));
        await new Promise((resolve) => setTimeout(resolve, 650));
      }
    });

    expect(counts.nextPrepare).toBe(1);
  } finally {
    await browser.close();
  }
});

test('billboard passes over a portrait trailer for one that fills the slide', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mock(page, {
      sources: [
        // A Short, which reel offers because it is the best rung of the trailer it found. On a slide
        // this wide it plays as a thin strip between two black columns, and the letterbox crop cannot
        // help: there is no picture at the sides for it to find.
        {
          kind: 'mp4',
          url: 'http://internal/m/s/tall.webm',
          audio: false,
          height: 1280,
          width: 720,
        },
        {
          kind: 'mp4',
          url: 'http://internal/m/s/wide.webm',
          audio: false,
          height: 720,
          width: 1280,
        },
      ],
      crop: null,
    });
    // Both play perfectly well. The first is passed over on its shape alone — not, as in the test
    // below, because it failed to load.
    await routeMedia(page, 'http://internal/m/s/tall.webm', serveVideo);
    await routeMedia(page, 'http://internal/m/s/wide.webm', serveVideo);
    await start(page);
    const video = page.locator('video.ambient');
    await expect(video).toHaveAttribute('src', relayUrl('http://internal/m/s/wide.webm'), {
      timeout: 15000,
    });
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
    await routeMedia(page, 'http://internal/m/s/gone.webm', (r) => r.fulfill({ status: 404 }));
    await routeMedia(page, 'http://internal/m/s/second.webm', serveVideo);
    await start(page);
    const video = page.locator('video.ambient');
    await expect(video).toHaveAttribute('src', relayUrl('http://internal/m/s/second.webm'), {
      timeout: 15000,
    });
    // An unmeasured trailer draws as it always did, with no transform at all.
    await expect(video).not.toHaveAttribute('style', /scale/);
  } finally {
    await browser.close();
  }
});

test('billboard tries a prepare alternate without repeating an unavailable primary', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mock(
      page,
      { sources: [] },
      {
        v: 2,
        meta: {
          links: [
            {
              planUrl: planUrl('alternate'),
            },
          ],
        },
        primary: null,
        primaryPlan: null,
      },
    );
    let primarySources = 0;
    await page.route('**/sources/trailer.json**', (route) => {
      primarySources++;
      return route.fulfill({ json: { v: 2, expires: EXPIRES, crop: null, sources: [] } });
    });
    await page.route('**/sources/alternate.json**', (route) =>
      route.fulfill({
        json: sourcePlan({
          sources: [
            {
              kind: 'mp4',
              url: 'http://internal/m/s/alternate.webm',
              audio: false,
              height: 720,
              width: 1280,
            },
          ],
        }),
      }),
    );
    await routeMedia(page, 'http://internal/m/s/alternate.webm', serveVideo);

    await start(page);
    await expect(page.locator('video.ambient')).toHaveAttribute(
      'src',
      relayUrl('http://internal/m/s/alternate.webm'),
      { timeout: 15000 },
    );
    expect(primarySources).toBe(0);
  } finally {
    await browser.close();
  }
});
