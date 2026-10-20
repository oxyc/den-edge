// A paired library's den-edge, in memory, for specs that run the production Worker: `/lib/*` answers like the real
// thing, and `edge` lets a spec hold, slow or refuse the writes (`/batch`) to see what the page does meanwhile.
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

export const FIXTURE = `${E2E_ORIGIN}/test/worker-hydration.html`;

/**
 * - `edge.delay`: milliseconds every batch write waits before it is answered.
 * - `edge.hold`: a promise every batch write waits for (a spec releases it).
 * - `edge.refuse`: batch writes are refused for good (a 400 `invalid_batch`).
 * - `edge.drop`: batch writes never get through, as with no connection.
 * - `edge.batches`: how many batch writes arrived, answered or not.
 * - `edge.upgradeRequired`: the library's minimum wire; a request on an older one gets a 426 (`edge.refused` counts).
 * - `edge.seedRow(libraryId, key, value)`: seed one opaque server row for an already-opened library.
 */
export async function routeLibraryEdge(page, edge = {}) {
  edge.batches = 0;
  edge.wires = [];
  edge.libraryRequests = [];
  edge.refused = 0;
  const generation = 'optimistic-actions';
  const libraries = new Map();
  const libraryFor = (libraryId) => {
    let library = libraries.get(libraryId);
    if (!library) {
      library = { rows: new Map(), head: 0 };
      libraries.set(libraryId, library);
    }
    return library;
  };
  edge.seedRow = (libraryId, k, v) => {
    const library = libraryFor(libraryId);
    library.rows.set(k, { k, seq: ++library.head, v });
  };

  await guardNetwork(page);
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await page.route('**/version', (route) =>
    route.fulfill({ json: { version: 'optimistic-test' } }),
  );
  await page.route('**/config', (route) => route.fulfill({ json: {} }));
  await page.route('**/oauth/connections', (route) => route.fulfill({ json: { connections: [] } }));
  // The seeded library lists one plugin, which the page asks about whenever it opens.
  await page.route('**/scout/fixture-install/manifest.json', (route) =>
    route.fulfill({ json: { id: 'com.den.scout' } }),
  );
  await page.route(`${E2E_ORIGIN}/recovery`, (route) =>
    route.fulfill({ status: 403, json: { error: 'forbidden' } }),
  );
  await page.route(`${E2E_ORIGIN}/lib/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const libraryId = url.pathname.split('/')[2];
    const library = libraryFor(libraryId);
    const wire = request.headers()['x-den-wire'];
    edge.wires.push(wire);
    const recorded = {
      libraryId,
      method: request.method(),
      path: url.pathname,
      body: request.postData() ?? null,
      wire,
    };
    edge.libraryRequests.push(recorded);
    edge.trace?.push(`${Date.now() % 100000} ${request.method()} ${url.pathname.split('/').pop()}`);
    const headers = {
      'x-den-generation': generation,
      'x-den-wire-min': String(edge.upgradeRequired ?? 4),
    };
    if (edge.upgradeRequired && Number(wire) < edge.upgradeRequired) {
      edge.refused++;
      return route.fulfill({ status: 426, headers, json: { error: 'upgrade_required' } });
    }
    if (url.pathname.endsWith('/member') && request.method() === 'PUT')
      return route.fulfill({ status: 200, headers });
    if (url.pathname.endsWith('/changes') && request.method() === 'GET') {
      const since = Number(url.searchParams.get('since') ?? 0);
      const entries = [...library.rows.values()].filter((entry) => entry.seq > since);
      recorded.entries = entries.length;
      recorded.entryKeys = entries.map(({ k }) => k);
      return route.fulfill({
        headers,
        json: { generation, entries, head: library.head, more: false },
      });
    }
    if (url.pathname.endsWith('/batch') && request.method() === 'POST') {
      edge.batches++;
      if (edge.hold) await edge.hold;
      if (edge.delay) await new Promise((done) => setTimeout(done, edge.delay));
      if (edge.drop) return route.abort('connectionfailed');
      if (edge.refuse)
        return route.fulfill({ status: 400, headers, json: { error: 'invalid_batch' } });
      const body = request.postDataJSON();
      const applied = [];
      const conflicts = [];
      for (const write of body.writes) {
        const current = library.rows.get(write.k);
        if ((current?.seq ?? 0) !== write.base) {
          conflicts.push({ k: write.k, seq: current?.seq ?? 0, v: current?.v ?? null });
          continue;
        }
        const entry = { k: write.k, seq: ++library.head, v: write.v };
        library.rows.set(write.k, entry);
        applied.push({ k: write.k, seq: entry.seq });
      }
      return route.fulfill({ headers, json: { applied, conflicts } });
    }
    return route.abort('blockedbyclient');
  });
  await routeTmdb(page, (route) => {
    const match = new URL(route.request().url()).pathname.match(/\/movie\/(\d+)$/);
    if (!match) return route.fulfill({ json: { page: 1, total_pages: 1, results: [] } });
    return route.fulfill({
      json: {
        id: Number(match[1]),
        title: `Movie ${match[1]}`,
        release_date: '2026-01-01',
        overview: 'A movie, for the detail page to show.',
        poster_path: '/poster.jpg',
        backdrop_path: '/backdrop.jpg',
        vote_average: 7.5,
        vote_count: 500,
        genres: [{ id: 18 }],
        credits: { cast: [], crew: [] },
        recommendations: { results: [] },
        external_ids: {},
      },
    });
  });
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"/>',
    }),
  );
}

/** Seed the library in this browser once, then reopen it paired on the title's page. */
export async function openPairedTitle(page, id) {
  await page.goto(`${FIXTURE}?seed`);
  await page
    .getByRole('status')
    .filter({ hasText: 'Worker library seeded' })
    .waitFor({ timeout: 15_000 });
  await page.goto(`${FIXTURE}?online&title=movie:${id}`);
  await page.getByRole('heading', { name: `Movie ${id}`, level: 1 }).waitFor();
}
