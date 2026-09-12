import { expect, it } from 'vitest';
import { parseSources, prepareSource, scoutTicket, fetchSources } from './titleSources';
import { DownloadQueue } from './downloadQueue.svelte';
const addon = { install: 'http://lan:8080/config', base: '/scout/config' };
const routes = { scout: [{ url: 'http://lan:8080' }] };
const raw = { title: 'Film.mkv', url: 'http://lan:8080/p/ticket', behaviorHints: { filename: 'Film.mkv' }, attributes: { resolution: '2160p', hdr: true, cached: false, sizeBytes: 1000 } };
it('rewrites current tickets and legacy play URLs only from configured Scout origins', () => {
  expect(scoutTicket(raw.url, addon, routes)).toBe('/scout/p/ticket');
  expect(scoutTicket('http://lan:8080/config/play/token', addon, {})).toBe('/scout/config/play/token');
  expect(scoutTicket('https://untrusted.example/p/ticket', addon, routes)).toBeNull();
  expect(scoutTicket('http://lan:8080/manifest.json', addon, routes)).toBeNull();
});
it('preserves unknown readiness and only trusts supplied display metadata', () => {
  const sources = parseSources({ streams: [raw, raw, { ...raw, title: 'Other', behaviorHints: {}, attributes: {} }] }, addon, routes)!;
  expect(sources).toHaveLength(2); expect(sources[0]).toMatchObject({ cached: false, badges: ['4K', 'HDR'] });
  expect(sources[1]!.cached).toBeUndefined(); expect(sources[1]!.probed).toBe(false);
});
it('scopes series sources to the exact requested episode', async () => {
  let path = '';
  const network = (async (input) => { path = String(input); return Response.json({ streams: [] }); }) as typeof fetch;
  await fetchSources(addon, 'tt1', routes, 3, 7, undefined, network);
  expect(path).toBe('/scout/config/stream/series/tt1%3A3%3A7.json');
});
it('queues once, probes without adding again, and never follows media redirects', async () => {
  const asked: { path: string; redirect?: string }[] = [];
  const network = (async (input, init) => { asked.push({ path: String(input), redirect: init?.redirect }); return new Response(null, { status: 302, headers: { location: 'https://media.example/movie.mkv' } }); }) as typeof fetch;
  expect(await prepareSource('/scout/p/ticket', true, network)).toEqual({ state: 'ready' });
  expect(await prepareSource('/scout/p/ticket', false, network)).toEqual({ state: 'ready' });
  expect(asked).toEqual([{ path: '/scout/p/ticket', redirect: 'manual' }, { path: '/scout/p/ticket?probe=1', redirect: 'manual' }]);
  expect(await prepareSource('https://untrusted.example/', true, network)).toEqual({ state: 'failed' });
});
it('does not mistake pending, absent or failed downloads for ready files', async () => {
  const response = (status: number, body: object) => (async () => Response.json(body, { status })) as typeof fetch;
  expect(await prepareSource('/scout/p/ticket', false, response(202, { progress: .35 }))).toEqual({ state: 'preparing', progress: .35 });
  expect((await prepareSource('/scout/p/ticket', false, response(404, { error: 'not_queued' }))).state).toBe('not-queued');
  expect((await prepareSource('/scout/p/ticket', false, response(503, {}))).state).toBe('unknown');
});
it('coalesces duplicate download presses across page instances and only probes after an uncertain result', async () => {
  const requests: boolean[] = [];
  const queue = new DownloadQueue(async (_, start) => { requests.push(start); await Promise.resolve(); return { state: 'unknown' }; });
  const source = parseSources({ streams: [raw] }, addon, routes)![0]!;
  await Promise.all([queue.start('movie', source), queue.start('movie', source)]);
  await queue.start('movie', source); await queue.poll('movie', source);
  expect(requests).toEqual([true, false]);
});
