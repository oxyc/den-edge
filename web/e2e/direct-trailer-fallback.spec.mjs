// Where a trailer's bytes come from, and what happens when a direct listener cannot be reached (oxyc/den#197).
//
// The public web name is served through Cloudflare, whose terms do not allow serving video, so there a trailer plays
// only from den-reel's direct listeners, routed as den-remux routes a session: the home-network listener first where
// den-edge names one (`lanBase`, at home, where the router does not loop the public address back in), then the public
// one. Each gets DIRECT_FIRST_FRAME_MS to show a frame; iOS's native player waits on an unreachable origin without an
// error, so the deadline is what moves it on. When neither plays, no trailer is shown, as remux shows no playback.
// A page on the LAN address or the tailnet is not Cloudflare and keeps the same-origin relay as its last copy.
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
const MEDIA = `/reel/m/s/${BLOB}?s=${TAG}`;
const SECOND_MEDIA = `/reel/m/s/${SECOND_BLOB}?s=${TAG}`;
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
 * reel offering one signed carried source, and den-edge activating with `lanBase` when `home`. `reach` says which
 * listeners answer: the others never do. The relay answers too, so a page that used it would be seen playing.
 * `csp` is the policy the page is served with; the dev server sends none of its own.
 */
async function mock(page, origin, { home, reach, csp = POLICY, firstFails = false }) {
  const seen = { activations: 0, lan: 0, direct: 0, relay: 0 };
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
  await page.route('**/reel/fixture/meta/**', (r) =>
    r.fulfill({
      json: {
        meta: {
          links: [
            {
              trailers: 'http://internal/play/trailer.webm',
              sources: 'http://internal/sources/trailer.json',
            },
            ...(firstFails
              ? [
                  {
                    trailers: 'http://internal/play/second.webm',
                    sources: 'http://internal/sources/second.json',
                  },
                ]
              : []),
          ],
        },
      },
    }),
  );
  await page.route('**/sources/*.json**', (r) => {
    const media = new URL(r.request().url()).pathname.includes('/second.json')
      ? SECOND_MEDIA
      : MEDIA;
    return r.fulfill({
      json: {
        sources: [{ kind: 'mp4', url: `http://internal${media}`, audio: true, height: 720 }],
      },
    });
  });
  await page.route(`${origin}/reel/activate`, (r) => {
    seen.activations += 1;
    const { media } = r.request().postDataJSON();
    return r.fulfill({
      json: {
        publicBase: DIRECT,
        media: `${DIRECT}${media}`,
        form: 'progressive',
        ...(home ? { lanBase: LAN } : {}),
      },
    });
  });
  // Every way a trailer's bytes could cross this origin: the carried copy, and reel's own file and siblings.
  await page.route(
    (url) => url.origin === origin && /^\/reel\/(?:m\/s|play|progressive|hls)\//.test(url.pathname),
    (route) => {
      seen.relay += 1;
      return serveVideo(route);
    },
  );
  await page.route(`${LAN}/**`, (route) => {
    seen.lan += 1;
    if (firstFails && new URL(route.request().url()).pathname === MEDIA.split('?')[0])
      return route.fulfill({ status: 502, body: 'progressive unavailable' });
    if (reach.includes('lan')) return serveVideo(route);
  });
  await page.route(`${DIRECT}/**`, (route) => {
    seen.direct += 1;
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
// engine/surface pair with one direct-success case and one relay-policy case.
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
          if (descriptor?.name === 'local-network-access')
            return Promise.resolve({ state: 'granted' });
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
        expect(lanDown.took).toBeLessThan(home.took + DEADLINE_MS + 1_500);
        test.info().annotations.push({
          type: 'time to playing',
          description: `${name}: home-network ${home.took} ms; home-network unreachable, public ${lanDown.took} ms`,
        });
      });

    if (covers.has('away'))
      test(`${name}: away plays from the public listener, never the relay`, async () => {
        test.skip(!available(), `${engine} is not installed here`);
        const away = await play(launch, surface, PUBLIC, { home: false, reach: ['public'] });
        expect(away.src).toBe(`${DIRECT}${MEDIA}`);
        expect(away.seen).toMatchObject({ lan: 0, relay: 0 });
        test.info().annotations.push({
          type: 'time to playing',
          description: `${name}: public ${away.took} ms`,
        });
      });

    if (covers.has('public-failure'))
      test(`${name}: on the public web name a failed direct listener means no trailer, as remux`, async () => {
        test.skip(!available(), `${engine} is not installed here`);
        const failed = await play(
          launch,
          surface,
          PUBLIC,
          { home: false, reach: [] },
          DEADLINE_MS + 4_000,
        );
        expect(failed.took, 'no trailer plays').toBeNull();
        expect(failed.seen.direct).toBeGreaterThan(0);
        expect(failed.seen.relay, 'and nothing crosses the relay').toBe(0);
      });

    if (covers.has('local-relay'))
      test(`${name}: on a local origin the relay is still the last copy`, async () => {
        test.skip(!available(), `${engine} is not installed here`);
        const local = await play(launch, surface, LOCAL, { home: false, reach: [] });
        expect(local.src).toBe(MEDIA);
        expect(local.seen.direct).toBeGreaterThan(0);
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
  expect(result.seen.activations).toBe(2);
  expect(result.seen.lan).toBeGreaterThan(1);
  expect(result.seen.direct, 'the public copy between candidates was tried').toBeGreaterThan(0);
  expect(result.seen.relay).toBe(0);
});
