import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const FIXTURE = `${E2E_ORIGIN}/test/worker-hydration.html`;
const trailerBytes = await readFile(new URL('./media/trailer.webm', import.meta.url));
const trailerCapability = `m/s/${'substance'.padEnd(40, '_')}?s=${'93'.repeat(12)}`;
const trailerPlanUrl = `${E2E_ORIGIN}/reel/sources/substance.json?v=2`;
const substance = {
  id: 933260,
  imdb_id: 'tt17526714',
  title: 'The Substance',
  media_type: 'movie',
  poster_path: '/substance-poster.jpg',
  backdrop_path: '/substance-backdrop.jpg',
  release_date: '2024-09-18',
  overview: 'A fading celebrity takes a black-market drug.',
  vote_average: 7.1,
  vote_count: 5_000,
  popularity: 100,
  genres: [{ id: 27, name: 'Horror' }],
  credits: { cast: [], crew: [] },
  recommendations: { results: [] },
  videos: { results: [] },
  external_ids: { imdb_id: 'tt17526714' },
};
const substancePlan = {
  v: 2,
  expires: 2_000_000_000,
  crop: null,
  sources: [
    {
      kind: 'mp4',
      audio: true,
      width: 1280,
      height: 720,
      delivery: { type: 'reel', capability: trailerCapability },
    },
  ],
};
const guest = {
  gid: 'feedcafe',
  name: 'Taylor',
  status: 'invited',
  addons: ['scout'],
  createdAt: 1_800_000_000_000,
  codeExpiresAt: 1_900_000_000_000,
  accessDays: null,
  accessUntil: null,
  redeemedAt: null,
  expiresAt: null,
  devices: 1,
  deviceCount: 0,
  lastUsedAt: null,
  playsTotal: 0,
  hoursTotal: 0,
  playsThisMonth: 0,
  hoursThisMonth: 0,
};

/** The small in-memory edge needed when a browser-local snapshot is reopened as a paired library. */
async function routeLibrary(page, metadata) {
  const generation = 'worker-hydration';
  const rows = new Map();
  let head = 0;
  const headers = { 'x-den-generation': generation, 'x-den-wire-min': '4' };

  await page.route(`${E2E_ORIGIN}/lib/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/grants')) {
      metadata.grantMembers ??= new Set();
      metadata.grantMembers.add(request.headers()['x-den-library-member']);
      return route.fulfill({
        headers,
        json:
          request.method() === 'GET'
            ? { grants: [metadata.guest ?? guest] }
            : { grant: metadata.guest ?? guest },
      });
    }
    if (url.pathname.endsWith(`/grants/${guest.gid}`) && request.method() === 'PUT') {
      const change = request.postDataJSON();
      metadata.grantUpdates?.push(change);
      if (typeof change.devices === 'number') {
        metadata.deviceUpdateStarted?.();
        if (metadata.releaseDeviceUpdate) await metadata.releaseDeviceUpdate;
        metadata.guest = { ...(metadata.guest ?? guest), devices: change.devices };
      }
      return route.fulfill({ headers, json: { grant: metadata.guest ?? guest } });
    }
    if (url.pathname.endsWith('/member') && request.method() === 'PUT') {
      metadata.members.add(request.headers()['x-den-library-member']);
      return route.fulfill({ status: 200, headers });
    }
    if (url.pathname.endsWith('/changes') && request.method() === 'GET') {
      metadata.changeRequests = (metadata.changeRequests ?? 0) + 1;
      if (metadata.holdChanges) {
        metadata.changesStarted?.();
        await metadata.releaseChanges;
      }
      const since = Number(url.searchParams.get('since') ?? 0);
      const entries = [...rows.values()].filter((entry) => entry.seq > since);
      return route.fulfill({
        headers,
        json: { generation, entries, head, more: false },
      });
    }
    if (url.pathname.endsWith('/batch') && request.method() === 'POST') {
      const body = request.postDataJSON();
      const applied = [];
      const conflicts = [];
      for (const write of body.writes) {
        const current = rows.get(write.k);
        if ((current?.seq ?? 0) !== write.base) {
          conflicts.push({
            k: write.k,
            seq: current?.seq ?? 0,
            v: current?.v ?? null,
          });
          continue;
        }
        const entry = { k: write.k, seq: ++head, v: write.v };
        rows.set(write.k, entry);
        applied.push({ k: write.k, seq: entry.seq });
      }
      return route.fulfill({ headers, json: { applied, conflicts } });
    }
    return route.abort('blockedbyclient');
  });
}

async function routes(page, metadata) {
  await guardNetwork(page);
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await page.route('**/version', (route) => route.fulfill({ json: { version: 'worker-test' } }));
  await page.route('**/config', (route) =>
    route.fulfill({ json: metadata.mcp ? { mcpUrl: `${E2E_ORIGIN}/mcp` } : {} }),
  );
  await page.route('**/oauth/connections', (route) => {
    metadata.oauthMembers ??= [];
    metadata.oauthMembers.push(route.request().headers()['x-den-library-member']);
    return route.fulfill({ json: { connections: [] } });
  });
  await page.route('**/scout/fixture-install/manifest.json', (route) => {
    const headers = route.request().headers();
    metadata.providerRequests ??= [];
    metadata.providerRequests.push({
      member: headers['x-den-library-member'],
      realm: headers['x-den-test-fetch-realm'],
    });
    return route.fulfill({ json: { id: 'com.den.scout' } });
  });
  await page.route('**/scout/fixture-install/stream/movie/tt1200.json', (route) =>
    route.fulfill({
      json: {
        streams: [
          {
            title: 'Queued.Movie.1080p.WEB.mkv',
            url: `${E2E_ORIGIN}/scout/fixture-install/play/queued`,
            behaviorHints: { filename: 'Queued.Movie.1080p.WEB.mkv' },
            attributes: { resolution: '1080p', cached: false, seeders: 5 },
          },
        ],
      },
    }),
  );
  await page.route('**/scout/fixture-install/stream/series/tt5194410%3A1%3A1.json', (route) => {
    metadata.sourceMembers ??= [];
    metadata.sourceMembers.push(route.request().headers()['x-den-library-member']);
    return route.fulfill({
      json: {
        streams: [
          {
            title: 'Springfloden.S01E01.1080p.WEB.mkv',
            url: `${E2E_ORIGIN}/scout/fixture-install/play/springfloden`,
            behaviorHints: { filename: 'Springfloden.S01E01.1080p.WEB.mkv' },
            attributes: { resolution: '1080p', cached: true, seeders: 5 },
          },
        ],
      },
    });
  });
  await page.route('**/scout/fixture-install/play/queued**', (route) =>
    route.fulfill({
      status: 202,
      json: { progress: 0.2, state: 'downloading', seeds: 5, peers: 7 },
    }),
  );
  await page.route(`${E2E_ORIGIN}/recovery`, (route) => {
    metadata.recoveryRequests = (metadata.recoveryRequests ?? 0) + 1;
    metadata.recoveryMembers ??= new Set();
    metadata.recoveryMembers.add(route.request().headers()['x-den-library-member']);
    return route.fulfill({ status: 403, json: { error: 'forbidden' } });
  });
  await routeLibrary(page, metadata);
  await routeTmdb(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const match = url.pathname.match(/\/(movie|tv)\/(\d+)$/);
    if (!match) {
      const trending = metadata.trending && url.pathname.includes('/trending/');
      return route.fulfill({
        json: {
          page: 1,
          total_pages: 1,
          results: trending
            ? [
                {
                  id: 901,
                  title: 'Generic trending pick',
                  release_date: '2026-01-01',
                  poster_path: '/poster.jpg',
                  backdrop_path: '/backdrop.jpg',
                  vote_average: 7.5,
                  vote_count: 500,
                  genre_ids: [18],
                },
              ]
            : [],
        },
      });
    }

    const [, type, rawId] = match;
    const id = Number(rawId);
    const ref = `${type}:${id}`;
    const headers = request.headers();
    metadata.requests.push({
      ref,
      url: `${url.pathname}${url.search}`,
      member: headers['x-den-library-member'],
      realm: headers['x-den-test-fetch-realm'],
    });
    const attempt = (metadata.attempts.get(ref) ?? 0) + 1;
    metadata.attempts.set(ref, attempt);
    if (metadata.refuseOnce.has(ref) && attempt === 1)
      return route.fulfill({ status: 503, headers: { 'retry-after': '1' }, body: '{}' });
    if (metadata.missing.has(ref))
      return route.fulfill({ status: 404, json: { error: 'not_found' } });
    if (id === metadata.holdId) {
      metadata.held();
      await metadata.release;
    }
    await metadata.beforeTitleRequest?.({ ref, url });
    const common = {
      id,
      poster_path: '/poster.jpg',
      backdrop_path: '/backdrop.jpg',
      vote_average: 7.5,
      vote_count: 500,
      genres: [{ id: 18 }],
      credits: { cast: [], crew: [] },
    };
    return route.fulfill({
      json:
        type === 'tv'
          ? {
              ...common,
              name: `Series ${id}`,
              first_air_date: '2026-01-01',
              seasons: [{ season_number: 1, episode_count: 8 }],
              last_episode_to_air: { season_number: 1, episode_number: 8 },
              external_ids: {},
            }
          : { ...common, title: `Movie ${id}`, release_date: '2026-01-01' },
    });
  });
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"/>',
    }),
  );
}

/**
 * The exact retained route that exposed the shared-Worker generation race: SVT's ambient billboard is already
 * playing, its press warms The Substance's audible Reel plan, then `title.detail` loses its first Worker reply.
 */
async function routeSvtSubstance(page, reelRequests, tmdbRequests) {
  await page.route('**/routes', (route) =>
    route.fulfill({ json: { reel: [{ url: E2E_ORIGIN }] } }),
  );
  await routeTmdb(page, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    tmdbRequests.push(url.href);
    const path = url.pathname.replace(/^\/(tmdb\/)?3\//, '/');
    if (path === '/watch/providers/movie')
      return route.fulfill({
        json: {
          results: [
            {
              provider_id: 493,
              provider_name: 'SVT',
              logo_path: '/svt.jpg',
              display_priority: 1,
            },
          ],
        },
      });
    if (path === '/watch/providers/tv') return route.fulfill({ json: { results: [] } });
    if (path === '/discover/movie')
      return route.fulfill({
        json: { page: 1, total_pages: 1, total_results: 1, results: [substance] },
      });
    if (path === '/movie/933260') return route.fulfill({ json: substance });
    if (path === '/movie/933260/external_ids')
      return route.fulfill({ json: { id: 933260, imdb_id: substance.imdb_id } });
    return route.fulfill({ json: { page: 1, total_pages: 1, total_results: 0, results: [] } });
  });
  await page.route('**/reel/manifest.json', (route) =>
    route.fulfill({ json: { id: 'com.den.reel' } }),
  );
  await page.route('**/reel/prepare/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    reelRequests.push({
      path: `${url.pathname}${url.search}`,
      member: request.headers()['x-den-library-member'],
    });
    const warm = url.searchParams.get('intent') === 'warm';
    return route.fulfill({
      json: {
        v: 2,
        meta: { links: [{ planUrl: trailerPlanUrl }] },
        primary: { id: 'substance', planUrl: trailerPlanUrl },
        ...(warm ? {} : { primaryPlan: substancePlan }),
      },
    });
  });
  await page.route('**/reel/sources/substance.json**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    reelRequests.push({
      path: `${url.pathname}${url.search}`,
      member: request.headers()['x-den-library-member'],
    });
    return route.fulfill({ json: substancePlan });
  });
  await page.route('**/reel/transport', (route) => {
    const request = route.request();
    reelRequests.push({
      path: '/reel/transport',
      member: request.headers()['x-den-library-member'],
    });
    return route.fulfill({
      json: {
        v: 2,
        capability: trailerCapability,
        attempts: [{ type: 'relay', url: `/reel/${trailerCapability}` }],
      },
    });
  });
  await page.route('**/scout/fixture-install/stream/movie/tt17526714.json', (route) =>
    route.fulfill({ json: { streams: [] } }),
  );
  await page.route(
    (url) => `${url.pathname}${url.search}` === `/reel/${trailerCapability}`,
    (route) => {
      const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Number(range[2]) : trailerBytes.length - 1;
      return route.fulfill({
        status: range ? 206 : 200,
        contentType: 'video/webm',
        body: trailerBytes.subarray(start, end + 1),
        headers: {
          'accept-ranges': 'bytes',
          ...(range ? { 'content-range': `bytes ${start}-${end}/${trailerBytes.length}` } : {}),
        },
      });
    },
  );
}

test('SVT billboard navigation keeps its warmed detail trailer on the paired Worker generation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    let nextWorker = 0;
    let failNextDetail = false;
    let failedDetail = false;
    window.fixtureWorkerMessages = [];
    window.fixtureFailNextDetail = () => (failNextDetail = true);
    window.Worker = class extends NativeWorker {
      fixtureId = ++nextWorker;

      constructor(url, options) {
        super(url, options);
        window.fixtureWorkerCount = nextWorker;
      }

      postMessage(message, ...rest) {
        window.fixtureWorkerMessages.push({
          worker: this.fixtureId,
          type: message?.type,
          kind: message?.request?.kind,
        });
        // Let the real request enter the Worker, then fail the shared transport. The paired library supervisor must
        // own the replacement before Content retries the warmed detail on that same generation.
        if (
          failNextDetail &&
          !failedDetail &&
          message?.type === 'content-query' &&
          message.request?.kind === 'title.detail'
        ) {
          failedDetail = true;
          const sent = super.postMessage(message, ...rest);
          queueMicrotask(() =>
            this.dispatchEvent(
              new ErrorEvent('error', { message: 'fixture content transport was replaced' }),
            ),
          );
          return sent;
        }
        return super.postMessage(message, ...rest);
      }
    };
  });

  const metadata = {
    requests: [],
    attempts: new Map(),
    members: new Set(),
    held: () => {},
    release: Promise.resolve(),
    refuseOnce: new Set(),
    missing: new Set(),
    holdId: null,
  };
  const reelRequests = [];
  const tmdbRequests = [];
  await routes(page, metadata);
  await routeSvtSubstance(page, reelRequests, tmdbRequests);
  await page.goto(`${FIXTURE}?seed`);
  await expect(page.getByRole('status').filter({ hasText: 'Worker library seeded' })).toBeVisible({
    timeout: 15_000,
  });

  reelRequests.length = 0;
  tmdbRequests.length = 0;
  await page.goto(`${FIXTURE}?routed&online`);
  await page.evaluate(() =>
    document.dispatchEvent(
      new CustomEvent('den:navigate', { detail: { path: '/service/493-se' } }),
    ),
  );
  const active = page.locator('[data-route-page][data-active="true"]');
  await expect(active.getByRole('heading', { name: 'SVT' })).toBeVisible();
  const billboard = active.locator('.billboard');
  await expect(billboard.getByRole('heading', { name: 'The Substance' })).toBeVisible();
  await expect(billboard.locator('video.ambient')).toHaveClass(/\bplaying\b/, { timeout: 15_000 });

  await page.evaluate(() => window.fixtureFailNextDetail());
  await billboard.locator('.slide-link').click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/movie/933260-the-substance');
  const detail = page.locator('[data-route-page][data-active="true"]');
  await expect(detail.getByRole('heading', { name: 'The Substance' })).toBeVisible();
  await expect(detail.locator('[data-detail-media] video')).toHaveClass(/\bplaying\b/, {
    timeout: 15_000,
  });

  const worker = await page.evaluate(() => ({
    count: window.fixtureWorkerCount,
    messages: window.fixtureWorkerMessages,
  }));
  expect(worker.count).toBe(2);
  expect(worker.messages.filter(({ worker }) => worker === 2)[0]).toMatchObject({
    type: 'hello',
  });
  expect(
    worker.messages.filter(
      ({ worker, type, kind }) =>
        worker === 2 && type === 'content-query' && kind === 'title.detail',
    ),
  ).toHaveLength(1);

  const warmed = reelRequests.find(
    ({ path }) => path.includes('/prepare/movie/tmdb:933260.json') && path.includes('intent=warm'),
  );
  expect(
    warmed,
    'the billboard press warmed the audible detail plan before navigation',
  ).toBeTruthy();
  expect(reelRequests.filter(({ member }) => !member)).toEqual([]);
  expect(tmdbRequests.length).toBeGreaterThan(0);
  expect(tmdbRequests.every((href) => new URL(href).pathname.startsWith('/tmdb/'))).toBe(true);
});

test('a large paired Home reopens its direct detail from Continue Watching while naming stays live', async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!location.search.includes('roundtrip-detail')) return;
    history.replaceState({}, '', `/movie/1001${location.search}`);
    const NativeWorker = window.Worker;
    window.fixtureWorkerCount = 0;
    window.fixtureWorkerMessages = [];
    window.fixtureWorkerTerminations = [];
    window.fixtureWorkers = [];
    window.fixtureFailCurrentWorker = () => {
      const worker = window.fixtureWorkers.at(-1);
      if (!worker) throw new Error('fixture has no Worker to fail');
      worker.dispatchEvent(
        new ErrorEvent('error', { message: 'fixture terminated the current Worker transport' }),
      );
    };
    window.Worker = class extends NativeWorker {
      fixtureId;
      constructor(url, options) {
        super(url, options);
        this.fixtureId = ++window.fixtureWorkerCount;
        window.fixtureWorkers.push(this);
      }
      postMessage(message, ...rest) {
        window.fixtureWorkerMessages.push({
          worker: this.fixtureId,
          type: message?.type,
          kind: message?.request?.kind,
        });
        return super.postMessage(message, ...rest);
      }
      terminate() {
        window.fixtureWorkerTerminations.push(this.fixtureId);
        return super.terminate();
      }
    };
  });
  let holdWideDetails = false;
  const wideDetails = Array.from({ length: 5 }, () => {
    let release;
    return {
      release: new Promise((resolve) => (release = resolve)),
      finish: release,
    };
  });
  let wideDetail = 0;
  const metadata = {
    requests: [],
    attempts: new Map(),
    members: new Set(),
    held: () => {},
    release: Promise.resolve(),
    refuseOnce: new Set(),
    missing: new Set(),
    holdId: null,
    beforeTitleRequest: async ({ ref, url }) => {
      if (
        !holdWideDetails ||
        ref !== 'movie:1001' ||
        !url.searchParams.get('append_to_response')?.includes('recommendations')
      )
        return;
      const held = wideDetails[wideDetail++];
      if (!held) throw new Error('unexpected sixth wide detail request');
      await held.release;
    },
  };
  await routes(page, metadata);
  await page.goto(`${FIXTURE}?seed`);
  await expect(page.getByRole('status').filter({ hasText: 'Worker library seeded' })).toBeVisible({
    timeout: 15_000,
  });

  metadata.requests.length = 0;
  await page.goto(`${FIXTURE}?routed&online&roundtrip-detail`);
  let active = page.locator('[data-route-page][data-active="true"]');
  await expect(active.getByRole('heading', { name: 'Movie 1001' })).toBeVisible({
    timeout: 15_000,
  });
  await page.evaluate(() => window.fixtureClearTmdbCache());

  metadata.changeRequests = 0;
  await page.evaluate(() =>
    document.dispatchEvent(new CustomEvent('den:navigate', { detail: { path: '/' } })),
  );
  active = page.locator('[data-route-page][data-active="true"]');
  const continued = active.getByRole('region', { name: 'Continue Watching', exact: true });
  const title = continued.getByRole('link', { name: /Movie 1001/ });
  await expect(title).toBeVisible({ timeout: 15_000 });
  await expect(active.getByRole('region', { name: 'Watchlist', exact: true })).toBeVisible();
  holdWideDetails = true;
  await title.click();
  for (let generation = 0; generation < 4; generation += 1) {
    await expect
      .poll(() => wideDetail, { message: `wide detail reached generation ${generation + 1}` })
      .toBe(generation + 1);
    await page.evaluate(() => window.fixtureFailCurrentWorker());
    wideDetails[generation].finish();
  }
  await expect
    .poll(() => wideDetail, { message: 'wide detail reached the fifth generation' })
    .toBe(5);
  wideDetails[4].finish();

  active = page.locator('[data-route-page][data-active="true"]');
  await expect(active.getByRole('heading', { name: 'Movie 1001' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(active.getByText('Couldn’t load this title from TMDB.')).toHaveCount(0);
  const worker = await page.evaluate(() => ({
    count: window.fixtureWorkerCount,
    messages: window.fixtureWorkerMessages,
    terminations: window.fixtureWorkerTerminations,
  }));
  expect(worker.count).toBe(5);
  expect(worker.terminations).toEqual([1, 2, 3, 4]);
  for (let generation = 2; generation <= 5; generation += 1) {
    const messages = worker.messages.filter(({ worker: id }) => id === generation);
    expect(messages[0]).toMatchObject({ type: 'hello' });
    const configured = messages.findIndex(
      ({ type, kind }) => type === 'content-query' && kind === 'sources.configure',
    );
    const detailed = messages.findIndex(
      ({ type, kind }) => type === 'content-query' && kind === 'title.detail',
    );
    expect(configured).toBeGreaterThan(0);
    expect(detailed).toBeGreaterThan(configured);
  }
  const titleRequests = metadata.requests.filter(({ ref }) => ref === 'movie:1001');
  expect(titleRequests.filter(({ url }) => url.includes('recommendations'))).toHaveLength(6);
  // Replacement reopens the already-current local snapshot; it must not manufacture a remote catch-up storm.
  expect(metadata.changeRequests).toBe(0);
});

test('a personal billboard keep cannot kill the Worker before reopening Verano azul', async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!location.search.includes('roundtrip-verano')) return;
    history.replaceState({}, '', `/tv/6066-verano-azul${location.search}`);
    const NativeWorker = window.Worker;
    window.fixtureWorkerCount = 0;
    window.fixtureWorkerMessages = [];
    window.fixtureWorkerTerminations = [];
    window.Worker = class extends NativeWorker {
      fixtureId;
      constructor(url, options) {
        super(url, options);
        this.fixtureId = ++window.fixtureWorkerCount;
      }
      postMessage(message, ...rest) {
        window.fixtureWorkerMessages.push({
          worker: this.fixtureId,
          type: message?.type,
          kind: message?.request?.kind,
          commandKind: message?.command?.kind,
          commandScope: message?.command?.scope,
        });
        return super.postMessage(message, ...rest);
      }
      terminate() {
        window.fixtureWorkerTerminations.push(this.fixtureId);
        return super.terminate();
      }
    };
  });
  const metadata = {
    requests: [],
    attempts: new Map(),
    members: new Set(),
    held: () => {},
    release: Promise.resolve(),
    refuseOnce: new Set(),
    missing: new Set(),
    holdId: null,
  };
  await routes(page, metadata);
  await page.route('**/atlas/manifest.json', (route) =>
    route.fulfill({ json: { id: 'com.den.atlas' } }),
  );
  await page.route('**/atlas/index/**', (route) => route.fulfill({ status: 404, json: {} }));
  await page.route('**/atlas/recommend/**', (route) =>
    route.fulfill({ json: { slides: [{ type: 'movie', id: 900 }] } }),
  );
  await page.route('**/atlas/recommend', (route) =>
    route.fulfill({
      json: {
        slides: [{ type: 'movie', id: 900, why: { score: 1, reason: 'similar' } }],
      },
    }),
  );

  await page.goto(`${FIXTURE}?seed&verano`);
  await expect(page.getByRole('status').filter({ hasText: 'Worker library seeded' })).toBeVisible({
    timeout: 15_000,
  });
  await page.goto(`${FIXTURE}?routed&online&roundtrip-verano`);
  let active = page.locator('[data-route-page][data-active="true"]');
  await expect(active.getByRole('heading', { name: 'Series 6066' })).toBeVisible({
    timeout: 15_000,
  });

  await page.evaluate(() =>
    document.dispatchEvent(new CustomEvent('den:navigate', { detail: { path: '/' } })),
  );
  active = page.locator('[data-route-page][data-active="true"]');
  const title = active
    .getByRole('region', { name: 'Continue Watching', exact: true })
    .getByRole('link', { name: /Series 6066/ });
  await expect(title).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.fixtureWorkerMessages.filter(
            ({ commandKind, commandScope }) =>
              commandKind === 'retained.billboard.set' && commandScope?.kind === 'personal',
          ).length,
      ),
    )
    .toBeGreaterThan(0);

  await title.click();
  active = page.locator('[data-route-page][data-active="true"]');
  await expect(active.getByRole('heading', { name: 'Series 6066' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(active.getByText('Couldn’t load this title from TMDB.')).toHaveCount(0);
  const worker = await page.evaluate(() => ({
    count: window.fixtureWorkerCount,
    terminations: window.fixtureWorkerTerminations,
  }));
  expect(worker).toEqual({ count: 1, terminations: [] });
  expect(metadata.requests.filter(({ ref }) => ref === 'tv:6066').length).toBeGreaterThan(0);
});

test('a large paired library cold-loads every lazy view through the Worker', async ({ page }) => {
  let releaseMetadata;
  let metadataHeld;
  const held = new Promise((resolve) => (metadataHeld = resolve));
  const release = new Promise((resolve) => (releaseMetadata = resolve));
  const metadata = {
    requests: [],
    attempts: new Map(),
    members: new Set(),
    held: metadataHeld,
    release,
    refuseOnce: new Set(['movie:1002']),
    missing: new Set([
      'movie:1004',
      'movie:1005',
      'movie:1006',
      'movie:1007',
      'movie:1008',
      'movie:1009',
      'movie:1010',
    ]),
    holdId: 1227,
    grantMembers: new Set(),
    providerRequests: [],
  };

  // Mark only window.fetch. A request without this marker was made in the DedicatedWorker's separate realm.
  await page.addInitScript(() => {
    const pageFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('x-den-test-fetch-realm', 'page');
      return pageFetch(input, { ...init, headers });
    };
  });
  await routes(page, metadata);
  await page.goto(`${FIXTURE}?seed`);
  await expect(page.getByRole('status').filter({ hasText: 'Worker library seeded' })).toBeVisible({
    timeout: 15_000,
  });

  // Reopen the local snapshot as an online/paired library. History's second progressive metadata batch is held,
  // while the first batch and the small Home seed batch can already paint the real Watchlist screen.
  await page.goto(`${FIXTURE}?view=library&online`);
  const continued = page.getByRole('region', { name: 'Continue Watching', exact: true });
  const watchlist = page.getByRole('region', { name: 'Watchlist', exact: true });
  const watched = page.getByRole('region', { name: 'Watched', exact: true });
  await expect(continued.getByText('Movie 1001')).toBeVisible();
  const series = continued.getByRole('link', { name: /Series 1003/ });
  await expect(series).toBeVisible();
  await expect(series).toContainText('S1 · E2');
  await expect(watchlist.getByText('Movie 1002')).toBeVisible();
  // Seven confirmed-absent records cannot strand the shelf at its first eight refs: naming scans forward until
  // the row has real cards, while the temporarily refused first title returns only after its requested pause.
  await expect(watchlist.getByText('Movie 1011')).toBeVisible();
  await expect(watchlist.getByText('Movie 1012')).toBeVisible();
  await expect(watched.getByText('Movie 1100')).toBeVisible();
  await held;

  // Provider work is detached from the Worker's authority lane: this write must finish before the held metadata
  // response is released, and the visible projection must update from the command's replacement.
  await continued.getByRole('link', { name: /Movie 1001/ }).hover();
  await continued.getByRole('button', { name: 'Remove from Continue Watching Movie 1001' }).click();
  await expect(continued.getByText('Movie 1001')).toHaveCount(0);

  releaseMetadata();
  await expect(watchlist.getByRole('heading', { name: 'Watchlist 10', exact: true })).toBeVisible();
  await expect(watched.getByRole('heading', { name: 'Watched 128', exact: true })).toBeVisible();

  const workerRequests = metadata.requests.filter(({ realm }) => realm === undefined);
  expect(metadata.members.size).toBe(1);
  const [membership] = metadata.members;
  expect(workerRequests.length).toBeGreaterThan(120);
  expect(membership).toMatch(/^[a-f0-9]{32}:[a-f0-9]{64}$/);
  expect(workerRequests.every(({ member }) => member === membership)).toBe(true);
  const counts = new Map();
  for (const { url } of workerRequests) counts.set(url, (counts.get(url) ?? 0) + 1);
  const repeated = [...counts].filter(([, count]) => count > 1);
  expect(repeated).toHaveLength(1);
  expect(repeated[0]?.[0]).toContain('/movie/1002?');
  expect(repeated[0]?.[1]).toBe(2);

  // A direct Settings document, its hard refresh, and Home's client-side transition must all observe the same
  // bootstrapped membership. The host grants call and page-owned provider discovery are never sent as a visitor.
  metadata.grantMembers.clear();
  metadata.providerRequests.length = 0;
  await page.goto(`${FIXTURE}?view=settings&online`);
  const openGuests = async () => {
    await page.getByRole('button', { name: 'Invite a guest Lend your addons' }).click();
    const invited = page.getByRole('listitem').filter({ hasText: 'Taylor' });
    await expect(invited).toBeVisible();
    await expect(invited).toContainText('Not used yet');
  };
  const pageProviderMembers = () =>
    metadata.providerRequests.filter(({ realm }) => realm === 'page').map(({ member }) => member);

  await openGuests();
  await expect.poll(() => [...metadata.grantMembers]).toEqual([membership]);
  await expect.poll(pageProviderMembers).toContain(membership);

  metadata.grantMembers.clear();
  await page.reload();
  await openGuests();
  await expect.poll(() => [...metadata.grantMembers]).toEqual([membership]);

  metadata.grantMembers.clear();
  metadata.providerRequests.length = 0;
  await page.goto(`${FIXTURE}?view=home&online`);
  await expect(page.getByRole('region', { name: 'Continue Watching', exact: true })).toBeVisible();
  await expect.poll(pageProviderMembers).toContain(membership);
  const openSettings = page.getByRole('button', { name: 'Open Settings' });
  await openSettings.focus();
  await openSettings.press('Enter');
  await openGuests();
  await expect.poll(() => [...metadata.grantMembers]).toEqual([membership]);
});

test('a cold paired Worker authenticates a direct-IMDb episode source request', async ({
  page,
}) => {
  const metadata = {
    requests: [],
    attempts: new Map(),
    members: new Set(),
    held: () => {},
    release: Promise.resolve(),
    refuseOnce: new Set(),
    missing: new Set(),
    holdId: null,
    sourceMembers: [],
  };

  await routes(page, metadata);
  await page.goto(`${FIXTURE}?seed`);
  await expect(page.getByRole('status').filter({ hasText: 'Worker library seeded' })).toBeVisible({
    timeout: 15_000,
  });

  await page.goto(`${FIXTURE}?online&source`);
  await expect(
    page.getByRole('status').filter({ hasText: 'Worker episode sources ready' }),
  ).toBeVisible({ timeout: 15_000 });
  expect(metadata.members.size).toBe(1);
  expect(metadata.sourceMembers).toEqual([...metadata.members]);
});

test('cold Settings stays loading and sends no member traffic before library bootstrap', async ({
  page,
}) => {
  let changesStarted;
  let releaseChanges;
  const held = new Promise((resolve) => (changesStarted = resolve));
  const release = new Promise((resolve) => (releaseChanges = resolve));
  const metadata = {
    requests: [],
    attempts: new Map(),
    members: new Set(),
    held: () => {},
    release: Promise.resolve(),
    refuseOnce: new Set(),
    missing: new Set(),
    holdId: null,
    mcp: true,
    oauthMembers: [],
    holdChanges: false,
    changesStarted,
    releaseChanges: release,
  };

  metadata.holdChanges = true;
  await routes(page, metadata);
  await page.goto(`${FIXTURE}?view=settings&online`);
  await held;
  await expect(page.getByRole('status').filter({ hasText: 'Loading your settings' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Plugins' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Assistants', exact: true })).toHaveCount(0);
  expect(metadata.oauthMembers).toEqual([]);

  metadata.holdChanges = false;
  releaseChanges();
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  const plugins = page.getByRole('region', { name: 'Plugins' });
  await expect(plugins).toBeVisible({ timeout: 15_000 });
  await expect(plugins).toContainText('No plugins yet');
  await expect.poll(() => metadata.oauthMembers).toHaveLength(1);
  expect(metadata.oauthMembers[0]).toMatch(/^[a-f0-9]{32}:[a-f0-9]{64}$/);
});

test('paired billboard holds the early generic fallback until retained lookup settles', async ({
  page,
}) => {
  let holdAtlas = false;
  let releaseAtlas;
  const atlasReleased = new Promise((resolve) => (releaseAtlas = resolve));
  let releaseRanking;
  const rankingReleased = new Promise((resolve) => (releaseRanking = resolve));
  const recommendations = [];
  let atlasProbes = 0;
  const metadata = {
    requests: [],
    attempts: new Map(),
    members: new Set(),
    held: () => {},
    release: Promise.resolve(),
    refuseOnce: new Set(),
    missing: new Set(),
    holdId: null,
    trending: true,
  };

  await routes(page, metadata);
  await page.route('**/atlas/manifest.json', async (route) => {
    atlasProbes++;
    if (holdAtlas) await atlasReleased;
    await route.fulfill({ json: { id: 'com.den.atlas' } });
  });
  await page.route('**/scout/fixture-install/manifest.json', (route) =>
    route.fulfill({ json: { id: 'com.den.scout' } }),
  );
  await page.route('**/atlas/index/**', (route) => route.fulfill({ status: 404, json: {} }));
  await page.route('**/atlas/recommend/**', (route) =>
    route.fulfill({
      json: {
        slides: [{ type: 'movie', id: 901, score: 1, why: { reason: 'Popular today' } }],
      },
    }),
  );
  await page.route('**/atlas/recommend', async (route) => {
    recommendations.push(route.request().postDataJSON());
    await rankingReleased;
    await route.fulfill({
      json: {
        slides: [{ type: 'movie', id: 902, score: 1, why: { reason: 'For this library' } }],
      },
    });
  });

  await page.goto(`${FIXTURE}?seed`);
  await expect(page.getByRole('status').filter({ hasText: 'Worker library seeded' })).toBeVisible({
    timeout: 15_000,
  });

  const seededProbes = atlasProbes;
  holdAtlas = true;
  await page.goto(`${FIXTURE}?view=home&online`);
  // Home deliberately admits generic content while Atlas discovery is unresolved. Even after that row has loaded,
  // its title must not enter a paired billboard before the retained lookup has had the chance to answer.
  await expect.poll(() => atlasProbes).toBeGreaterThan(seededProbes);
  await expect(
    page
      .getByRole('region', { name: 'Trending This Week' })
      .getByRole('link', { name: 'Generic trending pick' }),
  ).toBeVisible();
  await expect(
    page.locator('.billboard').getByRole('heading', { name: 'Generic trending pick' }),
  ).toHaveCount(0);

  releaseAtlas();
  await expect.poll(() => recommendations.length).toBeGreaterThan(0);
  await expect(page.getByRole('heading', { name: 'Retained personal pick' })).toBeVisible();

  const [ranking] = recommendations;
  expect(ranking.library.length).toBeGreaterThan(100);
  expect(ranking.library.find(({ id }) => id === 1012)?.hint?.title).toBe('Movie 1012');
  releaseRanking();
  const hero = page.locator('.billboard');
  const visible = hero.locator('.slide[aria-hidden="false"]');
  await expect(hero.locator('.slide')).toHaveCount(2);
  await expect(visible.getByRole('heading', { name: 'Retained personal pick' })).toBeVisible();

  // The first user or timer-driven move reaches the fresh ranking normally. Once it has arrived, the retained
  // lead is removed and that same title becomes slide zero without leaving the rail parked at the old offset.
  await hero.locator('.dot').nth(1).click();
  await expect(visible.getByRole('heading', { name: 'Movie 902' })).toBeVisible();
  await expect(hero.locator('.slide')).toHaveCount(1);
  await expect(hero.getByText('Retained personal pick')).toHaveCount(0);
  await expect.poll(() => hero.locator('.rail').evaluate((rail) => rail.scrollLeft)).toBe(0);
  await expect(visible).toHaveAttribute('aria-label', 'Movie 902');
});

test('a hidden paired library suspends background retries and resumes without a Recovery spin', async ({
  page,
}) => {
  const metadata = {
    requests: [],
    attempts: new Map(),
    members: new Set(),
    held: () => {},
    release: Promise.resolve(),
    refuseOnce: new Set(),
    missing: new Set(),
    holdId: null,
    changeRequests: 0,
    recoveryRequests: 0,
    recoveryMembers: new Set(),
  };

  // Playwright cannot background one page deterministically. This presents the same visibility fact and event that
  // the browser gives RoutedLibrary, while all scheduling, relay, Recovery, and download work remains in the real
  // production DedicatedWorker.
  await page.addInitScript(() => {
    let hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    window.fixtureVisibility = (value) => {
      hidden = value;
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
  await routes(page, metadata);
  await page.goto(`${FIXTURE}?seed&lifecycle`);
  await expect(page.getByRole('status').filter({ hasText: 'Worker library seeded' })).toBeVisible();

  await page.goto(`${FIXTURE}?view=settings&online&lifecycle`);
  await expect.poll(() => metadata.recoveryRequests).toBe(1);
  expect([...metadata.recoveryMembers]).toEqual([...metadata.members]);
  const hidden = { changes: metadata.changeRequests, recovery: metadata.recoveryRequests };
  await page.waitForTimeout(1_000);
  expect({ changes: metadata.changeRequests, recovery: metadata.recoveryRequests }).toEqual(hidden);

  await page.evaluate(() => window.fixtureVisibility(false));
  await expect.poll(() => metadata.changeRequests).toBeGreaterThan(hidden.changes);
  const visible = { changes: metadata.changeRequests, recovery: metadata.recoveryRequests };
  await page.waitForTimeout(1_000);
  expect({ changes: metadata.changeRequests, recovery: metadata.recoveryRequests }).toEqual(
    visible,
  );

  await page.evaluate(() => window.fixtureVisibility(true));
  const hiddenAgain = { changes: metadata.changeRequests, recovery: metadata.recoveryRequests };
  await page.waitForTimeout(1_000);
  expect({ changes: metadata.changeRequests, recovery: metadata.recoveryRequests }).toEqual(
    hiddenAgain,
  );
});

test('an invited guest device limit is saved and survives a Settings re-read', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let deviceUpdateStarted;
  let releaseDeviceUpdate;
  const updateStarted = new Promise((resolve) => (deviceUpdateStarted = resolve));
  const releaseUpdate = new Promise((resolve) => (releaseDeviceUpdate = resolve));
  const metadata = {
    requests: [],
    members: new Set(),
    held: () => {},
    release: Promise.resolve(),
    guest: { ...guest, devices: 2, deviceCount: 1 },
    grantUpdates: [],
    deviceUpdateStarted,
    releaseDeviceUpdate: releaseUpdate,
  };

  await routes(page, metadata);
  await page.goto(`${FIXTURE}?seed`);
  await expect(page.getByRole('status').filter({ hasText: 'Worker library seeded' })).toBeVisible({
    timeout: 15_000,
  });

  await page.goto(`${FIXTURE}?view=settings&online`);
  await page.getByRole('button', { name: 'Invite a guest Lend your addons' }).click();
  let invited = page.getByRole('listitem').filter({ hasText: 'Taylor' });
  const limit = invited.getByLabel('Device limit for Taylor');
  await expect(limit).toHaveValue('2');
  await expect(invited.getByText('Device limit', { exact: true })).toHaveCount(0);
  expect((await limit.boundingBox())?.width).toBeLessThan(120);
  await expect(invited).toContainText('1 of 2 devices');
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);

  await limit.selectOption('4');
  await updateStarted;
  await expect(limit).toBeDisabled();
  await expect(invited).toContainText('1 of 4 devices');
  releaseDeviceUpdate();

  await expect(limit).toHaveValue('4');
  await expect(invited).toContainText('1 of 4 devices');
  expect(metadata.grantUpdates.filter((change) => 'devices' in change)).toEqual([{ devices: 4 }]);

  // Reopening Settings asks den-edge for the grant again. The control must render the value returned by that fresh
  // read, not a visit-local selection left behind by the native picker.
  await page.reload();
  await page.getByRole('button', { name: 'Invite a guest Lend your addons' }).click();
  invited = page.getByRole('listitem').filter({ hasText: 'Taylor' });
  await expect(invited.getByLabel('Device limit for Taylor')).toHaveValue('4');
  await expect(invited).toContainText('1 of 4 devices');
});
