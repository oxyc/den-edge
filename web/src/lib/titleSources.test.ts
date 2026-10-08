import { expect, it } from 'vitest';
import {
  ageOf,
  fetchSourceList,
  parseAnswer,
  parseSources,
  prepareSource,
  scoutTicket,
  fetchSources,
} from './titleSources';
const addon = { install: 'http://lan:8080/config', base: '/scout/config' };
const routes = { scout: [{ url: 'http://lan:8080' }] };
const raw = {
  title: 'Film.mkv',
  url: 'http://lan:8080/p/ticket',
  behaviorHints: { filename: 'Film.mkv' },
  attributes: { resolution: '2160p', hdr: true, cached: false, sizeBytes: 1000 },
};
it('rewrites current tickets and legacy play URLs only from configured Scout origins', () => {
  expect(scoutTicket(raw.url, addon, routes)).toBe('/scout/p/ticket');
  expect(scoutTicket('http://lan:8080/config/play/token', addon, {})).toBe(
    '/scout/config/play/token',
  );
  expect(scoutTicket('https://untrusted.example/p/ticket', addon, routes)).toBeNull();
  expect(scoutTicket('http://lan:8080/manifest.json', addon, routes)).toBeNull();
});
it('preserves unknown readiness and only trusts supplied display metadata', () => {
  const sources = parseSources(
    { streams: [raw, raw, { ...raw, title: 'Other', behaviorHints: {}, attributes: {} }] },
    addon,
    routes,
  )!;
  expect(sources).toHaveLength(2);
  expect(sources[0]).toMatchObject({ cached: false, badges: ['4K', 'HDR'] });
  expect(sources[1]!.cached).toBeUndefined();
  expect(sources[1]!.probed).toBe(false);
});
it('carries the season pack a probed episode came from as context, never in place of its own size', () => {
  const episode = {
    title: 'Show.S01E03.1080p.WEB-DL.mkv',
    url: 'http://lan:8080/p/ticket-ep',
    behaviorHints: { filename: 'Show.S01E03.1080p.WEB-DL.mkv' },
    attributes: {
      resolution: '1080p',
      cached: true,
      sizeBytes: 1_136_580_921,
      packSizeBytes: 68_000_000_000,
    },
  };
  const [source] = parseSources({ streams: [episode] }, addon, routes)!;
  expect(source!.size).toBe(1_136_580_921);
  expect(source!.packSize).toBe(68_000_000_000);
  // A plain movie, with no pack behind it, gets none — not a zero, not the same number twice.
  const [movie] = parseSources({ streams: [raw] }, addon, routes)!;
  expect(movie!.packSize).toBeUndefined();
});
it('a never-opened pack sends sizeBytes:null — size must become undefined, never 0 or NaN', () => {
  const unopened = {
    title: 'Show.S01.COMPLETE.1080p.WEB-DL.mkv',
    url: 'http://lan:8080/p/ticket-pack',
    behaviorHints: { filename: 'Show.S01.COMPLETE.1080p.WEB-DL.mkv' },
    attributes: {
      resolution: '1080p',
      cached: true,
      sizeBytes: null,
      packSizeBytes: 68_000_000_000,
    },
  };
  const [source] = parseSources({ streams: [unopened] }, addon, routes)!;
  expect(source!.size).toBeUndefined();
  expect(source!.packSize).toBe(68_000_000_000);
});
it('scopes series sources to the exact requested episode', async () => {
  let path = '';
  const network = (async (input) => {
    path = String(input);
    return Response.json({ streams: [] });
  }) as typeof fetch;
  await fetchSources(addon, 'tt1', routes, 3, 7, undefined, network);
  expect(path).toBe('/scout/config/stream/series/tt1%3A3%3A7.json');
});
it('reads what scout says about its list, and nothing from an older scout or a malformed one', () => {
  const den = (extra: object) => ({
    streams: [],
    den: { v: 1, generatedAt: '2026-09-22T12:00:00Z', coverage: { sources: [] }, ...extra },
  });
  expect(parseAnswer({ streams: [] })).toBeUndefined();
  expect(parseAnswer(den({ answerKind: 'maybe' }))).toBeUndefined();
  expect(parseAnswer({ streams: [], den: 'live' })).toBeUndefined();
  expect(parseAnswer(den({ answerKind: 'empty' }))).toEqual({ kind: 'empty', missing: 0 });
  // Only a source that could have been asked and did not answer counts as missing.
  expect(
    parseAnswer(
      den({
        answerKind: 'unknown',
        coverage: {
          sources: [
            { id: 'torrentio', outcome: 'answered' },
            { id: 'comet', outcome: 'timeout' },
            { id: 'mediafusion', outcome: 'skipped_misconfigured' },
            { id: 'torz', outcome: 'quarantined' },
            { id: 'own', outcome: 'unreachable' },
          ],
        },
      }),
    ),
  ).toMatchObject({ kind: 'unknown', missing: 2 });
  // A held list is an outage only when scout says so; a list merely past its freshness is not.
  expect(parseAnswer(den({ answerKind: 'stale', degraded: 'stale_list' }))?.outage).toEqual({
    builtAt: Date.parse('2026-09-22T12:00:00Z'),
  });
  expect(parseAnswer(den({ answerKind: 'stale' }))?.outage).toBeUndefined();
});
it('hands the list and scout’s account of it back together', async () => {
  const network = (async () =>
    Response.json({
      streams: [raw],
      den: { answerKind: 'partial', coverage: { sources: [] } },
    })) as typeof fetch;
  const got = await fetchSourceList(addon, 'tt1', routes, undefined, undefined, undefined, network);
  expect(got.sources).toHaveLength(1);
  expect(got.answer?.kind).toBe('partial');
  const down = (async () => new Response('', { status: 502 })) as typeof fetch;
  expect(
    await fetchSourceList(addon, 'tt1', routes, undefined, undefined, undefined, down),
  ).toEqual({ sources: null });
});
it('says how long ago a held list was built', () => {
  const now = Date.parse('2026-09-22T12:00:00Z');
  expect(ageOf(now - 20_000, now)).toBe('1 min');
  expect(ageOf(now - 5 * 60_000, now)).toBe('5 min');
  expect(ageOf(now - 3 * 3_600_000, now)).toBe('3 h');
  expect(ageOf(now - 3 * 86_400_000, now)).toBe('3 days');
});
it('queues once, probes without adding again, and never follows media redirects', async () => {
  const asked: { path: string; redirect?: string }[] = [];
  const network = (async (input, init) => {
    asked.push({ path: String(input), redirect: init?.redirect });
    return new Response(null, {
      status: 302,
      headers: { location: 'https://media.example/movie.mkv' },
    });
  }) as typeof fetch;
  expect(await prepareSource('/scout/p/ticket', true, network)).toEqual({ state: 'ready' });
  expect(await prepareSource('/scout/p/ticket', false, network)).toEqual({ state: 'ready' });
  expect(asked).toEqual([
    { path: '/scout/p/ticket', redirect: 'manual' },
    { path: '/scout/p/ticket?probe=1', redirect: 'manual' },
  ]);
  expect(await prepareSource('https://untrusted.example/', true, network)).toEqual({
    state: 'failed',
  });
});
it('does not mistake pending, absent or failed downloads for ready files', async () => {
  const response = (status: number, body: object) =>
    (async () => Response.json(body, { status })) as typeof fetch;
  expect(await prepareSource('/scout/p/ticket', false, response(202, { progress: 0.35 }))).toEqual({
    state: 'preparing',
    progress: 0.35,
  });
  expect(
    (await prepareSource('/scout/p/ticket', false, response(404, { error: 'not_queued' }))).state,
  ).toBe('not-queued');
  // A 503 is the debrid refusing, a fact about the account; anything else unexpected says nothing.
  expect(
    await prepareSource('/scout/p/ticket', false, response(503, { service: 'torbox' })),
  ).toEqual({ state: 'refused', service: 'torbox' });
  expect((await prepareSource('/scout/p/ticket', false, response(500, {}))).state).toBe('unknown');
});
it('reads everything scout says about a fetch, as the TV does', async () => {
  const response = (status: number, body: object, headers: Record<string, string> = {}) =>
    (async () => Response.json(body, { status, headers })) as typeof fetch;
  expect(
    await prepareSource(
      '/scout/p/ticket',
      false,
      response(202, {
        progress: 0.12,
        etaSeconds: 300,
        bytesPerSecond: 500_000,
        state: 'stalled',
        seeds: 0,
        peers: 2,
        service: 'torbox',
      }),
    ),
  ).toEqual({
    state: 'preparing',
    progress: 0.12,
    etaSeconds: 300,
    bytesPerSecond: 500_000,
    fetch: { state: 'stalled', seeds: 0, peers: 2, service: 'torbox' },
  });
  // An older scout's 202 carries none of the debrid's account.
  expect((await prepareSource('/scout/p/t', false, response(202, { progress: 0.5 }))).fetch).toBe(
    undefined,
  );
  // Parked behind the debrid's own slot limit — no torrent yet, so no swarm to report — must still read
  // as `fetch.state: 'queued'`, which is what turns into "Queued at TorBox" (downloadStatus.headline).
  expect(
    await prepareSource(
      '/scout/p/ticket',
      false,
      response(202, { progress: 0, state: 'queued', service: 'torbox' }),
    ),
  ).toEqual({
    state: 'preparing',
    progress: 0,
    fetch: { state: 'queued', service: 'torbox' },
  });
  expect(
    (await prepareSource('/scout/p/t', false, response(410, { error: 'ticket_expired' }))).state,
  ).toBe('expired');
  const held = await prepareSource(
    '/scout/p/t',
    true,
    response(503, { error: 'reserved_for_play' }, { 'retry-after': '600' }),
    true,
  );
  expect(held.state).toBe('paused');
  expect(held.until! - Date.now()).toBeGreaterThan(590_000);
});
it('asks to add as a prefetch, which scout holds back for Play', async () => {
  const asked: string[] = [];
  const network = (async (input) => {
    asked.push(String(input));
    return new Response(null, { status: 302 });
  }) as typeof fetch;
  await prepareSource('/scout/p/ticket', true, network, true);
  expect(asked).toEqual(['/scout/p/ticket?prefetch=1']);
});
