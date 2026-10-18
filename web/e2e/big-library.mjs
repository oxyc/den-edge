// A household the size of a long-lived one, for any spec: a profile household (Owner and Kid) whose Owner library
// holds about 1,890 titles (1,500 films, 380 series, ~170 on the watchlist, 30 being watched), 11,000-odd episode
// marks, 3,000 tracker receipts, a few film downloads and a season downloading — about 6,100 rows — and an assistant
// allowed to change and read it. Generated, never hand-written: the same rows for the whole UTC day (their stamps are
// days before it), so a run is reproducible.
//
// Bugs that only a big library shows (work per title, per row, per card) stay hidden on the three-title fixtures most
// specs use. `bigHousehold` makes one through the real app, against the in-memory den-edge of `guest-edge.mjs`, and
// `routeBigTmdb` answers TMDB with bodies the size of TMDB's own.
//
//   const edge = newEdge({ profiles: true });
//   const context = await browser.newContext(devices['iPhone 13']);
//   await bigHousehold(context, edge);                       // once per file
//   const page = await context.newPage();
//   await routeBigHousehold(page, edge);                     // per page, before it loads

import { expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { syntheticRows } from '../scripts/rehearse-synthetic.mjs';
import { evaluateAssistant, initializeAssistant } from '../src/vendor/den-core/assistant.js';
import { E2E_ORIGIN } from './base-url.mjs';
import { CODE, routeGuestEdge } from './guest-edge.mjs';
import { routeTmdb } from './network.mjs';

const DAY = 86_400_000;

/** Today at midnight UTC: every stamp in the fixture is some days before it. */
export const fixtureNow = () => Math.floor(Date.now() / DAY) * DAY;

/** A series being watched (`rehearse-synthetic.mjs`: every fifteenth long-history series), with four seasons. */
export const WATCHED_SERIES = 200_000;

/** Its last season, downloading: two episodes have a release, the rest are still searched for. */
const SEASON_DOWNLOAD = { season: 4, episodes: 10, released: 2 };

/** What the fixture holds, for assertions and for budgets that scale with it. */
export const BIG_LIBRARY = {
  films: 1_510,
  series: 380,
  watching: 30,
  downloads: 6 + SEASON_DOWNLOAD.episodes,
};

const setting = (name, values) => ({ kind: 'set', schema: 2, name, values });
const text = (value, at) => ({ value: { string: value }, at });

export function bigLibraryRows(now = fixtureNow()) {
  const rows = syntheticRows(now, { large: true });
  const at = [now - DAY, 0, 'aaaaaaaaaaaaaaaa'];
  // Five more downloads beside the synthetic household's one: films queued over the last days.
  for (let i = 1; i <= 5; i += 1) {
    const id = 100_000 + i * 7;
    rows.push(
      setting(`download:movie:${id}:-1:-1`, {
        release: text(
          JSON.stringify({
            identity: String(i).repeat(40).slice(0, 40),
            label: `Synthetic.Release.${i}.1080p`,
            url: 'https://example.invalid/p/ticket',
          }),
          at,
        ),
        title: text(JSON.stringify({ mediaType: 'movie', mediaId: id, title: `Film ${id}` }), at),
        queuedAt: { value: { int: now - i * DAY }, at },
      }),
    );
  }
  // A season download in progress: one row per episode, queued yesterday.
  const { season, episodes, released } = SEASON_DOWNLOAD;
  for (let episode = 1; episode <= episodes; episode += 1) {
    const title = {
      mediaType: 'tv',
      mediaId: WATCHED_SERIES,
      season,
      episode,
      title: `Series ${WATCHED_SERIES}`,
    };
    rows.push(
      setting(`download:tv:${WATCHED_SERIES}:${season}:${episode}`, {
        ...(episode <= released
          ? {
              release: text(
                JSON.stringify({
                  identity: `episode-${episode}.mkv`,
                  label: `Series.S0${season}E${String(episode).padStart(2, '0')}.1080p.mkv`,
                  url: 'https://example.invalid/p/ticket',
                }),
                at,
              ),
            }
          : {}),
        title: text(JSON.stringify(title), at),
        queuedAt: { value: { int: now - DAY }, at },
      }),
    );
  }
  return rows;
}

/** den-core's assistant op `request`, as the library Worker runs it. */
let assistantLoaded;
async function assistantOp(request) {
  assistantLoaded ??= initializeAssistant(
    readFileSync(
      new URL('../src/vendor/den-core/generated/den_core_assistant_bg.wasm', import.meta.url),
    ),
  );
  await assistantLoaded;
  const answer = JSON.parse(evaluateAssistant(JSON.stringify(request)));
  if (answer.version !== 1 || !('ok' in answer)) throw new Error(`den-core: ${answer.error}`);
  return answer.ok;
}

/** 32 bytes, as hex, the same every run: what the fixture's keys are made from. */
const fixedRandom = (name) => createHash('sha256').update(`den-e2e-${name}`).digest('hex');

/**
 * The household's connection to an assistant that may change and read its library, made a day ago as Settings'
 * consent makes it (den-spec assistant-v1 §1, §15, §16): a drop-box key, a grant, a play record and a read record.
 * They are household rows (profiles-v1 §6.1), so the split leaves them with the household. `grant`: its id.
 */
export async function assistantRows(now = fixtureNow()) {
  const at = [now - DAY, 1, 'aaaaaaaaaaaaaaaa'];
  const client = 'Claude';
  const dropbox = await assistantOp({
    op: 'assistant_keygen_dropbox',
    random: fixedRandom('dropbox'),
  });
  const grant = await assistantOp({
    op: 'assistant_keygen_grant',
    random: fixedRandom('grant'),
    client,
    ops: ['rate', 'seen', 'watchlist_add', 'watchlist_remove'],
    cap: 100,
    now: now - DAY,
  });
  const play = await assistantOp({
    op: 'assistant_keygen_play',
    grant: grant.grant,
    client,
    now: now - DAY,
  });
  const read = await assistantOp({
    op: 'assistant_keygen_read',
    grant: grant.grant,
    random: fixedRandom('read'),
    client,
    now: now - DAY,
  });
  const row = (name, made) => setting(name, { [made.setting]: { value: made.value, at } });
  return {
    grant: grant.grant,
    rows: [
      row('assistant', dropbox),
      row('assistant-grants', grant),
      row('assistant-play', play),
      row('assistant-read', read),
    ],
  };
}

const memberOf = (request) => request.headers()['x-den-library-member']?.split(':')[0] ?? null;

/**
 * den-edge's assistant routes for the household's connection (`assistantRows`): it is listed to every member, its
 * projection taken, `projectionMs` late, and its queue held empty. What was uploaded is kept on `edge.assistant`.
 */
async function routeBigAssistant(page, edge, projectionMs) {
  const seen = (edge.assistant ??= { grant: null, projections: [] });
  await page.route(`${E2E_ORIGIN}/oauth/connections`, (route) =>
    route.fulfill({
      json: {
        connections: seen.grant
          ? [
              {
                sid: 'fedcba9876543210fedcba9876543210',
                client: 'Claude',
                redirectHost: 'claude.ai',
                kind: 'member',
                guest: null,
                createdAt: fixtureNow() - DAY,
                usedAt: fixtureNow() - DAY,
                grant: seen.grant,
                write: true,
                read: true,
              },
            ]
          : [],
      },
    }),
  );
  await page.route(`${E2E_ORIGIN}/assistant/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/assistant/dropbox') return route.fulfill({ status: 204 });
    if (path.startsWith('/assistant/projection/') && request.method() === 'PUT') {
      seen.projections.push({ member: memberOf(request), at: Date.now() });
      if (projectionMs) await new Promise((done) => setTimeout(done, projectionMs));
      return route.fulfill({ status: 204 });
    }
    if (path === '/assistant/drain') return route.fulfill({ json: { messages: [] } });
    if (path === '/assistant/ack') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: {} });
  });
}

const people = (kind) => ({
  cast: Array.from({ length: kind === 'movie' ? 120 : 30 }, (_, i) => ({
    id: 10_000 + i,
    name: `Cast Member ${i}`,
    original_name: `Cast Member ${i}`,
    character: `Character ${i}`,
    profile_path: `/profile-${i}.jpg`,
    credit_id: `52fe4250c3a36847f80149f${i}`,
    known_for_department: 'Acting',
    popularity: 3.2,
    order: i,
  })),
  crew: Array.from({ length: kind === 'movie' ? 160 : 40 }, (_, i) => ({
    id: 20_000 + i,
    name: `Crew Member ${i}`,
    job: i === 0 ? 'Director' : 'Producer',
    department: i === 0 ? 'Directing' : 'Production',
    credit_id: `52fe4250c3a36847f80149e${i}`,
    profile_path: null,
    popularity: 1.1,
  })),
});

/**
 * TMDB as the app asks den-edge for it, each answer `latencyMs` late and the size of TMDB's own with credits
 * appended (a series about 21 KB, a film about 73 KB): a list's titles, a title's details, a season's episodes.
 */
export async function routeBigTmdb(page, { latencyMs = 0 } = {}) {
  const headers = { 'cache-control': 'max-age=3600' };
  await routeTmdb(page, async (route) => {
    if (latencyMs) await new Promise((done) => setTimeout(done, latencyMs));
    const url = new URL(route.request().url());
    const [kind, id, sub, n] = url.pathname.replace(/^\/(?:tmdb\/)?3\//, '').split('/');
    const common = {
      id: Number(id),
      poster_path: `/poster-${id}.jpg`,
      backdrop_path: `/backdrop-${id}.jpg`,
      overview: `The story of title ${id}.`,
      vote_average: 7.2,
      vote_count: 900,
      popularity: 50,
      original_language: 'en',
      genres: [{ id: 18, name: 'Drama' }],
      credits: people(kind),
      recommendations: { results: [] },
      similar: { results: [] },
      videos: { results: [] },
      external_ids: { imdb_id: `tt${String(id).padStart(7, '0')}` },
    };
    if (kind === 'movie' && /^\d+$/.test(id ?? '') && !sub)
      return route.fulfill({
        headers,
        json: { ...common, title: `Film ${id}`, release_date: '2001-01-01', runtime: 110 },
      });
    if (kind === 'tv' && /^\d+$/.test(id ?? '') && sub === 'season')
      return route.fulfill({
        headers,
        json: {
          id: Number(id) * 100 + Number(n),
          season_number: Number(n),
          name: `Season ${n}`,
          episodes: Array.from({ length: 10 }, (_, i) => ({
            id: Number(id) * 1000 + Number(n) * 20 + i,
            episode_number: i + 1,
            season_number: Number(n),
            name: `Episode ${i + 1}`,
            overview: 'An episode.',
            air_date: '2001-01-01',
            runtime: 45,
            still_path: `/still-${id}-${n}-${i}.jpg`,
          })),
        },
      });
    if (kind === 'tv' && /^\d+$/.test(id ?? '') && !sub)
      return route.fulfill({
        headers,
        json: {
          ...common,
          name: `Series ${id}`,
          first_air_date: '2001-01-01',
          status: 'Ended',
          number_of_seasons: 4,
          seasons: [1, 2, 3, 4].map((season) => ({
            season_number: season,
            episode_count: 10,
            name: `Season ${season}`,
          })),
        },
      });
    if (sub) return route.fulfill({ headers, json: { id: Number(id), results: [] } });
    // Any list — trending, discover, popular: twenty titles nobody in the household has seen.
    const type = url.pathname.includes('/tv') ? 'tv' : 'movie';
    return route.fulfill({
      headers,
      json: {
        page: 1,
        total_pages: 1,
        results: Array.from({ length: 20 }, (_, i) => ({
          id: 300_000 + i,
          media_type: type,
          [type === 'tv' ? 'name' : 'title']: `${type === 'tv' ? 'Series' : 'Film'} ${300_000 + i}`,
          poster_path: `/poster-${300_000 + i}.jpg`,
          backdrop_path: `/backdrop-${300_000 + i}.jpg`,
          genre_ids: [18],
          vote_average: 7,
          vote_count: 500,
          popularity: 90 - i,
          [type === 'tv' ? 'first_air_date' : 'release_date']: '2020-01-01',
          overview: 'Trending.',
        })),
      },
    });
  });
}

const card = (id, type = 'movie') => ({
  type,
  id,
  title: `${type === 'series' ? 'Series' : 'Film'} ${id}`,
  year: 2020,
  posterPath: `/poster-${id}.jpg`,
  backdropPath: `/backdrop-${id}.jpg`,
  genreIds: [16],
});

/**
 * atlas on the page's own origin, as much of it as a billboard and a Kid's Home ask: the Owner's ranking (three titles
 * the household hasn't seen, which the billboard then fills in from TMDB), a Kid Home catalogue of one row, and every
 * title admitted for a Kid. Anything else is "not here", as the shared fixtures answer it.
 */
async function routeBigAtlas(page, latencyMs) {
  await page.route('**/atlas/**', async (route) => {
    if (latencyMs) await new Promise((done) => setTimeout(done, latencyMs));
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/manifest.json'))
      return route.fulfill({ json: { id: 'com.den.atlas', name: 'atlas', catalogs: [] } });
    if (url.pathname.includes('/recommend'))
      return route.fulfill({
        json: {
          version: 1,
          slides: [400_001, 400_002, 400_003].map((id) => ({ type: 'movie', id })),
        },
      });
    if (url.pathname.endsWith('/index/kids-home.json'))
      return route.fulfill({
        json: {
          rows: [
            {
              id: 'adventures',
              title: 'Big Adventures',
              group: 'big-adventures',
              source: { kind: 'filter', type: 'all', selection: ['audience:made_for_children'] },
            },
          ],
        },
      });
    if (url.pathname.endsWith('/index/filter/all/titles.json'))
      return route.fulfill({
        json: {
          titles: Array.from({ length: 20 }, (_, i) => card(500_000 + i)),
          order: 'stable',
          ignored: [],
        },
      });
    const titled = /\/index\/title\/(movie|series)\/(\d+)\.json$/.exec(url.pathname);
    if (titled)
      return route.fulfill({
        json: {
          ...card(Number(titled[2]), titled[1]),
          indexed: true,
          eligible: true,
          minimumAge: 0,
          maturityRatings: [],
        },
      });
    return route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
}

/**
 * What publishing this household's assistant projection costs an iPhone's library Worker: from the page's first
 * assistant request to its projection upload, which is the time its shelves waited (den-edge's log, 0.271.69). A lab
 * Worker builds it in about 0.2 s, and Chromium can slow a page's CPU but not a Worker's, so `projectionMs` holds the
 * upload's answer this long instead: the library Worker is busy with the publish as long as the phone's was.
 */
export const PHONE_PROJECTION_MS = 6_000;

/**
 * One page of the big household: the in-memory den-edge with the household's assistant, TMDB and — unless `atlas` is
 * false, for a spec about a household with none — atlas, each answering `latencyMs` late; an assistant projection's
 * upload answers `projectionMs` late.
 */
export async function routeBigHousehold(
  page,
  edge,
  { latencyMs = 0, atlas = true, projectionMs = 0 } = {},
) {
  await routeGuestEdge(page, edge);
  await routeBigAssistant(page, edge, projectionMs);
  await page.route('**/metadata/title/query', (route) => route.fulfill({ json: { entries: [] } }));
  if (atlas) await routeBigAtlas(page, latencyMs);
  await routeBigTmdb(page, { latencyMs });
}

/**
 * Make the big household in `context` through the real app — rows written to a library kept only in this browser,
 * then a guest invite accepted, which starts a profile household and moves them into its Owner library — and leave
 * that browser as one that has been here before: every page opened in `context` afterwards is a returning visit.
 * `options` are `routeBigHousehold`'s, and the pages opened afterwards must be given the same: a browser remembers the
 * atlas it found.
 */
export async function bigHousehold(context, edge, options = {}) {
  const page = await context.newPage();
  const started = Date.now();
  const step = (what) =>
    process.env.BIG_LIBRARY_DEBUG &&
    console.log(`big library +${Date.now() - started}ms ${what}`, edge.libraryRequests.length);
  try {
    // Wide enough for the bar's own profile switcher, which says when the household has been made.
    await page.setViewportSize({ width: 1000, height: 900 });
    await routeBigHousehold(page, edge, options);
    await page.goto(`${E2E_ORIGIN}/test/seed-library.html`);
    await page.waitForFunction(() => typeof window.denSeed === 'function');
    step('seeding');
    const assistant = await assistantRows();
    edge.assistant.grant = assistant.grant;
    await page.evaluate((rows) => window.denSeed(rows), [...bigLibraryRows(), ...assistant.rows]);
    step('seeded');
    await page.goto(`${E2E_ORIGIN}/#invite=${CODE}`);
    await page
      .getByRole('dialog', { name: 'Accept this invite?' })
      .getByRole('button', { name: 'Accept' })
      .click();
    await expect(page.getByRole('button', { name: 'Switch profile, current Owner' })).toBeVisible({
      timeout: 90_000,
    });
    step('accepted');
    // The move is done once den-edge holds a library with the whole history in it: as Library v4 documents, one per
    // title and one per season, about 3,070 of them.
    await expect
      .poll(
        () => Math.max(0, ...[...edge.libraries.values()].map((library) => library.rows.size)),
        {
          timeout: 180_000,
          message: 'the Owner library holds the seeded rows',
        },
      )
      .toBeGreaterThan(3_000);
    step('moved');
    // A first visit to Home and to the Watchlist (which names the whole history) fills this browser's TMDB cache, so
    // every later load is a returning visit's.
    let lastTmdb = Date.now();
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/tmdb/')) lastTmdb = Date.now();
    });
    for (const path of ['/', '/watchlist']) {
      await page.goto(`${E2E_ORIGIN}${path}`);
      await expect(page.locator('main').getByText('Continue Watching').first()).toBeVisible({
        timeout: 90_000,
      });
      await expect
        .poll(() => Date.now() - lastTmdb, {
          timeout: 120_000,
          message: `${path} named everything`,
        })
        .toBeGreaterThan(3_000);
    }
    step('primed');
  } finally {
    await page.close();
  }
}
