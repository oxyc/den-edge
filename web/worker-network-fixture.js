/* global self */

const layouts = { 2004: [12], 2005: [8, 10, 6, 9] };
const requests = [];
const unexpected = [];
let atlasEnabled = false;
const jsonResponse = (json, status = 200) =>
  new Response(JSON.stringify(json), {
    status,
    headers: { 'content-type': 'application/json' },
  });

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  if (event.data === 'network-requests') event.ports[0].postMessage({ requests, unexpected });
  if (event.data?.type === 'configure') {
    atlasEnabled = event.data.atlas;
    event.ports[0].postMessage('configured');
  }
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const tmdb = url.pathname.startsWith('/tmdb/3/') || url.hostname === 'api.themoviedb.org';
  if (!tmdb) {
    const source =
      url.origin === self.location.origin &&
      /^\/(?:test\/|src\/|@|node_modules\/|favicon\.ico|worker-network-fixture\.)/.test(
        url.pathname,
      );
    if (source) return;
    if (url.hostname === 'image.tmdb.org') {
      event.respondWith(
        new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" width="342" height="513"><rect width="342" height="513" fill="blue"/></svg>',
          { headers: { 'content-type': 'image/svg+xml' } },
        ),
      );
      return;
    }
    const path = url.pathname;
    if (path === '/routes') event.respondWith(jsonResponse({}));
    else if (['/reel/health', '/remux/health', '/den/health'].includes(path))
      event.respondWith(jsonResponse({ error: 'not_found' }, 404));
    else if (/^\/(?:ratings|warnings)\/imdb\//.test(path))
      event.respondWith(jsonResponse({ error: 'not_cached' }, 404));
    else if (/\/index\/(?:suggest|title|franchise|versions)\//.test(path))
      event.respondWith(jsonResponse({ error: 'not_found' }, 404));
    else if (path === '/recovery') event.respondWith(jsonResponse({ entries: [] }));
    else if (path === '/tmdb/warm' || path === '/performance/event')
      event.respondWith(new Response(null, { status: 204 }));
    else if (path === '/capabilities/profiles')
      event.respondWith(jsonResponse({ error: 'not_found' }, 404));
    else if (path.startsWith('/metadata/title/query'))
      event.respondWith(jsonResponse({ entries: [] }));
    else if (path === '/metadata/title') event.respondWith(new Response(null, { status: 204 }));
    else if (path.startsWith('/atlas/')) {
      const chart = /\/catalog\/\w+\/(jw-nfx-new|jw-nfx-series-new)\//.exec(path)?.[1];
      if (path.endsWith('/atlas/manifest.json')) {
        event.respondWith(
          atlasEnabled
            ? jsonResponse({
                id: 'com.den.atlas',
                catalogs: [
                  {
                    type: 'movie',
                    id: 'jw-nfx-new',
                    name: 'New on Netflix',
                    denProviderIds: [8],
                  },
                  {
                    type: 'series',
                    id: 'jw-nfx-series-new',
                    name: 'New series on Netflix',
                    denProviderIds: [8],
                  },
                ],
              })
            : jsonResponse({ error: 'not_found' }, 404),
        );
      } else if (chart) {
        const metas =
          chart === 'jw-nfx-new'
            ? [{ type: 'movie', moviedb_id: 7102, name: 'Charted movie' }]
            : [
                { type: 'series', moviedb_id: 2005, name: 'Series 2005' },
                { type: 'series', moviedb_id: 7101, name: 'Charted series' },
              ];
        event.respondWith(
          jsonResponse({
            metas: metas.map((meta) => ({
              ...meta,
              posterPath: '/poster.jpg',
              releaseInfo: '2019',
            })),
          }),
        );
      } else if (path.includes('/catalog/')) event.respondWith(jsonResponse({ metas: [] }));
      else if (path.includes('/recommend'))
        event.respondWith(jsonResponse({ version: 1, slides: [] }));
      else if (path.includes('/index/suggest'))
        event.respondWith(jsonResponse({ perSeed: [], pooled: [] }));
      else event.respondWith(jsonResponse({ error: 'not_found' }, 404));
    } else {
      unexpected.push(`${event.request.method} ${url.origin}${path}`);
      event.respondWith(jsonResponse({ error: 'unmocked' }, 418));
    }
    return;
  }
  requests.push(url.pathname + url.search);
  const path = url.pathname;
  let json;
  if (path.includes('/watch/providers/')) {
    json = {
      results: [
        { provider_id: 8, provider_name: 'Netflix', logo_path: '/n.jpg', display_priority: 1 },
      ],
    };
  } else {
    const match = path.match(/\/(movie|tv)\/(\d+)$/);
    if (!match) {
      const page = Number(url.searchParams.get('page') || 1);
      const series = /\/tv\b/.test(path);
      json = {
        page,
        total_pages: 1,
        results:
          page > 1
            ? []
            : [
                {
                  id: series ? 7001 : 7002,
                  ...(series
                    ? { name: 'Unheld series', first_air_date: '2019-03-01' }
                    : { title: 'Unheld movie', release_date: '2019-03-01' }),
                  poster_path: '/poster.jpg',
                  vote_average: 7,
                  vote_count: 500,
                },
              ],
      };
    } else {
      const [, type, id] = match;
      const seasons = (layouts[id] || [8, 10]).map((episodes, index) => ({
        season_number: index + 1,
        episode_count: episodes,
      }));
      const charted = { 7101: 'Charted series', 7102: 'Charted movie' }[id];
      json = {
        id: Number(id),
        ...(type === 'movie'
          ? { title: charted || `Movie ${id}`, release_date: '2019-01-01' }
          : {
              name: charted || `Series ${id}`,
              first_air_date: '2019-01-01',
              seasons: [{ season_number: 0, episode_count: 3 }, ...seasons],
            }),
        poster_path: '/poster.jpg',
        vote_average: 7.5,
        vote_count: 500,
        genres: [{ id: 18, name: 'Drama' }],
      };
    }
  }
  event.respondWith(
    new Response(JSON.stringify(json), { headers: { 'content-type': 'application/json' } }),
  );
});
