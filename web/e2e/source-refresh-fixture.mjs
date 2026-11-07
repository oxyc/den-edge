import { guardNetwork, routeTmdb } from './network.mjs';

const art =
  '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="281"><rect width="500" height="281" fill="#264c68"/></svg>';

const source = (filename) => ({
  title: filename,
  url: 'http://scout.internal/p/ready',
  behaviorHints: { filename },
  attributes: { cached: true, resolution: '1080p' },
});

/** Install the smallest real Detail/source boundary used by hosted and packaged TV production builds. */
export async function sourceRefreshFixture(page, { bundled = false, packaged = false } = {}) {
  await guardNetwork(page);
  if (bundled) await page.route('**/assets/**', (route) => route.continue());
  if (packaged) await page.route('**/package/**', (route) => route.continue());
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: art }),
  );
  await page.route('**/atlas/index/studios/*/*.json', (route) =>
    route.fulfill({ json: { studios: [] } }),
  );
  await page.route('**/atlas/index/similar/**', (route) =>
    route.fulfill({ json: { ids: [], mixed: [] } }),
  );
  await page.route('**/atlas/index/suggest.json', (route) => {
    const { seeds } = route.request().postDataJSON();
    return route.fulfill({
      json: {
        perSeed: seeds.map((seed) => ({ seed, ids: [], mixed: [] })),
        pooled: [],
        pooledMixed: [],
      },
    });
  });
  await page.route('**/atlas/index/franchise/*/*.json', (route) => route.fulfill({ json: {} }));
  await page.route('**/metadata/title/query', (route) => route.fulfill({ json: { entries: [] } }));
  await routeTmdb(page, (route) =>
    route.fulfill({
      json: {
        title: 'A Film',
        external_ids: { imdb_id: 'tt42' },
        release_date: '2026-01-01',
        poster_path: '/poster.jpg',
        backdrop_path: '/backdrop.jpg',
        overview: 'A feature film.',
        credits: { cast: [], crew: [] },
        recommendations: { results: [] },
        genres: [{ id: 18, name: 'Drama' }],
      },
    }),
  );

  const requests = { fresh: 0, plain: 0, admitted: false };
  await page.route('**/scout/config/stream/movie/**', (route) => {
    const fresh = new URL(route.request().url()).searchParams.get('fresh') === '1';
    if (fresh) requests.fresh++;
    else requests.plain++;
    if (fresh && requests.fresh === 1)
      return route.fulfill({
        headers: { 'x-den-fresh': 'limited' },
        json: {
          streams: [source('Prior.Movie.1080p.mkv')],
          den: { answerKind: 'stale', coverage: { sources: [] } },
        },
      });
    if (fresh) requests.admitted = true;
    return route.fulfill({
      headers: fresh ? { 'x-den-fresh': 'rebuilt' } : {},
      json: {
        streams: [source(requests.admitted ? 'Rebuilt.Movie.1080p.mkv' : 'Prior.Movie.1080p.mkv')],
        den: {
          answerKind: requests.admitted ? 'live' : 'partial',
          coverage: { sources: requests.admitted ? [] : [{ outcome: 'late' }] },
        },
      },
    });
  });
  return requests;
}
