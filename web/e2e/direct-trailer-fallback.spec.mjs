// Where a trailer's bytes come from, and what happens when a direct listener cannot be reached (oxyc/den#197).
//
// The public web name is served through Cloudflare, whose terms do not allow serving video, so there a trailer plays
// from den-reel's direct listeners when they work. Reel v2 gives Edge an opaque carried-source capability and Edge
// returns its ordered transports: the home-network listener when applicable, the public listener, and the same-origin
// relay. Each direct attempt gets DIRECT_FIRST_FRAME_MS to show a frame; iOS's native player waits on an unreachable
// origin without an error, so the deadline is what moves it on. The relay remains the complete final playback path.
//
// "Unreachable" is a request that is never answered, which is what a dropped connection looks like to the element.
// The public web name is `den.localhost`: a name that is not local to the page (`relaysMedia`) but that the browser
// still resolves to the dev server.
import { test, expect, chromium, webkit } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { E2E_ORIGIN, E2E_PORT } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const videoBytes = await readFile(new URL('./media/trailer.webm', import.meta.url));
const LOCAL = E2E_ORIGIN;
const PUBLIC = `http://den.localhost:${E2E_PORT}`;
const DIRECT = 'https://media.invalid';
const LAN = 'https://lan.media.invalid:8449';
const BLOB = 'A'.repeat(40);
const SECOND_BLOB = 'B'.repeat(40);
const TAG = 'b'.repeat(24);
const CAPABILITY = `m/s/${BLOB}?s=${TAG}`;
const SECOND_CAPABILITY = `m/s/${SECOND_BLOB}?s=${TAG}`;
const MEDIA = `/reel/${CAPABILITY}`;
const SECOND_MEDIA = `/reel/${SECOND_CAPABILITY}`;
const EXPIRES = 2_000_000_000;
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
      'access-control-allow-origin': '*',
      ...(range ? { 'content-range': `bytes ${start}-${end}/${videoBytes.length}` } : {}),
    },
  });
};

/**
 * The media and fetch parts of den-edge's page policy (`web.rs` `csp`): media from any https origin, fetches only
 * from the origins it names — the public listener, never the home-network one.
 */
const POLICY = `media-src 'self' blob: data: https:; connect-src 'self' ${DIRECT}`;
/** The same with media named origin by origin, as before: what the home-network copy would meet without `https:`. */
const NAMED_ONLY = `media-src 'self' blob: data: ${DIRECT}; connect-src 'self' ${DIRECT}`;

/**
 * Reel v2 offering one signed carried source, and den-edge returning LAN/public/relay transports when `home`.
 * `reach` says which direct listeners answer: the others never do. The relay is the final complete path.
 * `csp` is the policy the page is served with; the dev server sends none of its own.
 */
async function mock(page, origin, { home, reach, csp = POLICY, firstFails = false }) {
  const seen = { lan: 0, direct: 0, relay: 0, order: [] };
  const sourcePlan = (capability) => ({
    v: 2,
    expires: EXPIRES,
    crop: null,
    sources: [
      {
        kind: 'mp4',
        audio: true,
        width: 1280,
        height: 720,
        delivery: { type: 'reel', capability },
      },
    ],
  });
  const planUrl = (id) => `http://internal/sources/${id}.json?v=2`;
  const mediaFor = (capability) => `/reel/${capability}`;
  const sourceName = (url) => (url.includes(SECOND_BLOB) ? 'second' : 'first');
  const note = (transport, url) => {
    const entry = `${transport}:${sourceName(url)}`;
    if (!seen.order.includes(entry)) seen.order.push(entry);
  };
  await guardNetwork(page, origin);
  // A request the policy refuses never leaves the browser, so it never reaches the routes below.
  await page.route(
    (url) => url.origin === origin && /^\/test\/[^/]+\.html$/.test(url.pathname),
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'content-security-policy': csp },
      });
    },
  );
  await routeTmdb(page, (r) => r.fulfill({ json: movie }));
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="blue"/></svg>',
    }),
  );
  await page.route('**/reel/fixture/prepare/**', (r) =>
    r.fulfill({
      json: {
        v: 2,
        meta: {
          links: [
            { planUrl: planUrl('trailer') },
            ...(firstFails ? [{ planUrl: planUrl('second') }] : []),
          ],
        },
        primary: { id: 'trailer', planUrl: planUrl('trailer') },
        primaryPlan: sourcePlan(CAPABILITY),
      },
    }),
  );
  await page.route('**/sources/*.json**', (r) => {
    const second = new URL(r.request().url()).pathname.includes('/second.json');
    return r.fulfill({ json: sourcePlan(second ? SECOND_CAPABILITY : CAPABILITY) });
  });
  await page.route(`${origin}/reel/transport`, (r) => {
    const { capability } = r.request().postDataJSON();
    const media = mediaFor(capability);
    return r.fulfill({
      json: {
        v: 2,
        capability,
        attempts: [
          ...(home ? [{ type: 'lan', url: `${LAN}${media}` }] : []),
          { type: 'public', url: `${DIRECT}${media}` },
          { type: 'relay', url: media },
        ],
      },
    });
  });
  // Every carried source that could cross this origin.
  await page.route(
    (url) => url.origin === origin && /^\/reel\/m\/s\//.test(url.pathname),
    (route) => {
      seen.relay += 1;
      note('relay', route.request().url());
      if (firstFails && route.request().url().includes(BLOB))
        return route.fulfill({ status: 502, body: 'relay unavailable' });
      return serveVideo(route);
    },
  );
  await page.route(`${LAN}/**`, (route) => {
    seen.lan += 1;
    note('lan', route.request().url());
    if (firstFails && new URL(route.request().url()).pathname === MEDIA.split('?')[0])
      return route.fulfill({ status: 502, body: 'progressive unavailable' });
    if (reach.includes('lan')) return serveVideo(route);
  });
  await page.route(`${DIRECT}/**`, (route) => {
    seen.direct += 1;
    note('public', route.request().url());
    if (reach.includes('public')) return serveVideo(route);
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
    open: (page, origin) => page.goto(`${origin}/test/detail-trailer.html`),
    video: '[data-detail-media] video',
  },
  {
    name: 'billboard',
    open: async (page, origin) => {
      await page.goto(`${origin}/test/billboard.html?reel=1`);
      await page.evaluate(() => window.dispatchEvent(new Event('fixture:titles')));
    },
    video: 'video.ambient',
  },
];

// reel.test.ts exhaustively covers the source order and timeout state machine. Here the browser is proving the
// integration boundaries: each engine and each independently implemented surface sees every route class once,
// without paying for their full 2 × 2 × 4 Cartesian product. The diagonal assignment also leaves every
// engine/surface pair with one direct-success case and one direct-to-relay fallback case.
const integrationCases = new Map([
  ['chromium hero', new Set(['away', 'public-failure'])],
  ['chromium billboard', new Set(['home', 'local-relay'])],
  ['webkit hero', new Set(['home', 'local-relay'])],
  ['webkit billboard', new Set(['away', 'public-failure'])],
]);

/** Opens the surface on `origin`; the time until its trailer is playing (null if it never does) and what played. */
async function play(launch, surface, origin, network, wait = 15_000) {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    if (network.home)
      await page.addInitScript(() => {
        // These cases model a browser that has already allowed Den to use its home-network listener. Chromium's
        // Local Network Access gate defaults to `prompt`; an ambient trailer must not raise that prompt itself,
        // so production correctly leaves LAN out until the grant exists. WebKit has no such permission policy.
        const permissions = globalThis.Permissions;
        if (!permissions) return;
        const query = permissions.prototype.query;
        permissions.prototype.query = function (descriptor) {
          if (descriptor?.name === 'local-network') return Promise.resolve({ state: 'granted' });
          return query.call(this, descriptor);
        };
      });
    const seen = await mock(page, origin, network);
    const began = Date.now();
    await surface.open(page, origin);
    const video = page.locator(surface.video);
    const played = await expect(video)
      .toHaveClass(/playing/, { timeout: wait })
      .then(() => true)
      .catch(() => false);
    const took = played ? Date.now() - began : null;
    const src = (await video.count()) ? await video.getAttribute('src') : null;
    return { took, src, seen };
  } finally {
    await browser.close();
  }
}

for (const [engine, launch, available = () => true] of engines) {
  for (const surface of surfaces) {
    const name = `${engine} ${surface.name}`;
    const covers = integrationCases.get(name);

    if (covers.has('home'))
      test(`${name}: at home plays from the home-network listener, never the relay`, async () => {
        test.skip(!available(), `${engine} is not installed here`);
        // Under den-edge's policy, which names no home-network origin: `media-src https:` alone lets it play.
        const home = await play(launch, surface, PUBLIC, { home: true, reach: ['lan'] });
        expect(home.src).toBe(`${LAN}${MEDIA}`);
        expect(home.seen).toMatchObject({ lan: expect.any(Number), direct: 0, relay: 0 });
        expect(home.seen.lan).toBeGreaterThan(0);
        // The control: without `https:` the same copy is refused before it is asked for, so the policy is in force.
        const named = await play(launch, surface, PUBLIC, {
          home: true,
          reach: ['lan', 'public'],
          csp: NAMED_ONLY,
        });
        expect(named.seen.lan, 'refused by the policy, never requested').toBe(0);
        expect(named.src).toBe(`${DIRECT}${MEDIA}`);
        // The home-network listener unreachable: the public one comes after it, one deadline later, no relay.
        const lanDown = await play(launch, surface, PUBLIC, { home: true, reach: ['public'] });
        expect(lanDown.src).toBe(`${DIRECT}${MEDIA}`);
        expect(lanDown.seen.relay).toBe(0);
        expect(lanDown.seen.order).toEqual(['lan:first', 'public:first']);
        expect(lanDown.took).toBeLessThan(home.took + DEADLINE_MS + 1_500);
        test.info().annotations.push({
          type: 'time to playing',
          description: `${name}: home-network ${home.took} ms; home-network unreachable, public ${lanDown.took} ms`,
        });
      });

    if (covers.has('away'))
      test(`${name}: away tries the public listener before any relay`, async () => {
        test.skip(!available(), `${engine} is not installed here`);
        const away = await play(launch, surface, PUBLIC, { home: false, reach: ['public'] });
        // A direct copy gets a deliberately short first-frame deadline. On a saturated WebKit runner the served
        // file can miss that deadline even though its request succeeded; advancing to the relay is then the product
        // behavior under test, not a wrong URL. In either outcome public must be tried first and playback must use
        // either that exact copy or its ordered relay fallback, never skip straight to the relay.
        expect([`${DIRECT}${MEDIA}`, MEDIA]).toContain(away.src);
        expect(away.seen.lan).toBe(0);
        expect(away.seen.direct).toBeGreaterThan(0);
        expect(away.seen.order[0]).toBe('public:first');
        if (away.src === MEDIA) {
          expect(away.seen.relay).toBeGreaterThan(0);
          expect(away.seen.order).toEqual(['public:first', 'relay:first']);
        } else {
          expect(away.seen.relay).toBe(0);
          expect(away.seen.order).toEqual(['public:first']);
        }
        test.info().annotations.push({
          type: 'time to playing',
          description: `${name}: ${away.src === MEDIA ? 'relay after public deadline' : 'public'} ${away.took} ms`,
        });
      });

    if (covers.has('public-failure'))
      test(`${name}: on the public web name a failed direct listener falls through to the relay`, async () => {
        test.skip(!available(), `${engine} is not installed here`);
        const failed = await play(
          launch,
          surface,
          PUBLIC,
          { home: false, reach: [] },
          DEADLINE_MS + 4_000,
        );
        expect(failed.src).toBe(MEDIA);
        expect(failed.seen.direct).toBeGreaterThan(0);
        expect(failed.seen.relay).toBeGreaterThan(0);
        expect(failed.seen.order).toEqual(['public:first', 'relay:first']);
      });

    if (covers.has('local-relay'))
      test(`${name}: on a local origin the relay is still the last copy`, async () => {
        test.skip(!available(), `${engine} is not installed here`);
        const local = await play(launch, surface, LOCAL, { home: false, reach: [] });
        expect(local.src).toBe(MEDIA);
        expect(local.seen.direct).toBeGreaterThan(0);
        expect(local.seen.order).toEqual(['public:first', 'relay:first']);
        expect(local.took).toBeLessThan(DEADLINE_MS + 5_000);
      });
  }
}

test('detail hero tries the next LAN candidate when the first media file is unavailable', async () => {
  const hero = surfaces[0];
  const result = await play(
    engines[0][1],
    hero,
    PUBLIC,
    { home: true, reach: ['lan'], firstFails: true },
    DEADLINE_MS + 8_000,
  );
  expect(result.src).toBe(`${LAN}${SECOND_MEDIA}`);
  expect(result.seen.order).toEqual(['lan:first', 'public:first', 'relay:first', 'lan:second']);
});
