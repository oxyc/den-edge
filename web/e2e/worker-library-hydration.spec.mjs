import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const FIXTURE = `${E2E_ORIGIN}/test/worker-hydration.html`;
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
      return route.fulfill({
        headers,
        json: request.method() === 'GET' ? { grants: [guest] } : { grant: guest },
      });
    }
    if (url.pathname.endsWith('/member') && request.method() === 'PUT') {
      metadata.members.add(request.headers()['x-den-library-member']);
      return route.fulfill({ status: 200, headers });
    }
    if (url.pathname.endsWith('/changes') && request.method() === 'GET') {
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
  await page.route('**/config', (route) => route.fulfill({ json: {} }));
  await routeLibrary(page, metadata);
  await routeTmdb(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const match = url.pathname.match(/\/(movie|tv)\/(\d+)$/);
    if (!match) return route.fulfill({ json: { page: 1, total_pages: 1, results: [] } });

    const [, type, rawId] = match;
    const id = Number(rawId);
    const ref = `${type}:${id}`;
    const headers = request.headers();
    metadata.requests.push({
      ref,
      member: headers['x-den-library-member'],
      realm: headers['x-den-test-fetch-realm'],
    });
    if (id === 1227) {
      metadata.held();
      await metadata.release;
    }
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

test('a large paired library cold-loads every lazy view through the Worker', async ({ page }) => {
  let releaseMetadata;
  let metadataHeld;
  const held = new Promise((resolve) => (metadataHeld = resolve));
  const release = new Promise((resolve) => (releaseMetadata = resolve));
  const metadata = { requests: [], members: new Set(), held: metadataHeld, release };

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
  await expect(page.getByRole('status').filter({ hasText: 'Worker library seeded' })).toBeVisible();

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
  await expect(watched.getByText('Movie 1100')).toBeVisible();
  await held;

  // Provider work is detached from the Worker's authority lane: this write must finish before the held metadata
  // response is released, and the visible projection must update from the command's replacement.
  await continued.getByRole('link', { name: /Movie 1001/ }).hover();
  await continued.getByRole('button', { name: 'Remove from Continue Watching Movie 1001' }).click();
  await expect(continued.getByText('Movie 1001')).toHaveCount(0);

  releaseMetadata();
  await expect(watched.getByRole('heading', { name: 'Watched 128', exact: true })).toBeVisible();

  const workerRequests = metadata.requests.filter(({ realm }) => realm === undefined);
  expect(metadata.members.size).toBe(1);
  const [membership] = metadata.members;
  expect(workerRequests.length).toBeGreaterThan(120);
  expect(membership).toMatch(/^[a-f0-9]{32}:[a-f0-9]{64}$/);
  expect(workerRequests.every(({ member }) => member === membership)).toBe(true);
  const counts = new Map();
  for (const { ref } of workerRequests) counts.set(ref, (counts.get(ref) ?? 0) + 1);
  expect([...counts.values()].every((count) => count === 1)).toBe(true);

  // A second cold Worker opens under the already-mounted Settings screen. Its lazy Connections replacement is what
  // lets Sharing list the already-invited guest.
  await page.goto(`${FIXTURE}?view=settings&online`);
  await page.getByRole('button', { name: 'Invite a guest Lend your addons' }).click();
  const invited = page.getByRole('listitem').filter({ hasText: 'Taylor' });
  await expect(invited).toBeVisible();
  await expect(invited).toContainText('Not used yet');
});
