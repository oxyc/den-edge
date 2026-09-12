import type { Addon } from './scout';
import { within, type Routes } from './routes';

export interface TitleSource {
  filename: string; url: string; label: string; cached?: boolean; seeders?: number; size?: number;
  badges: string[]; languages: string[]; probed: boolean;
}

/** Playback tickets stay on our Scout relay. Never follow the media redirect while queuing a download. */
export function scoutTicket(url: string, addon: Addon, routes: Routes): string | null {
  const suffix = within(url, [...(routes.play ?? []), ...(routes.scout ?? []), { url: addon.install }]);
  if (!suffix || !/^\/(?:p\/[\w.~%-]+|(?:[\w.~%-]+\/)?play\/[\w.~%-]+)(?:\?[^#]*)?$/.test(suffix)) return null;
  if (url.startsWith(addon.install + '/') && suffix.startsWith('/play/')) return addon.base + suffix;
  return '/scout' + suffix;
}

export function parseSources(body: unknown, addon: Addon, routes: Routes): TitleSource[] | null {
  const streams = (body as { streams?: unknown } | null)?.streams;
  if (!Array.isArray(streams)) return null;
  const seen = new Set<string>();
  return streams.flatMap((s): TitleSource[] => {
    if (!s || typeof s.url !== 'string') return [];
    const url = scoutTicket(s.url, addon, routes);
    const filename = s.behaviorHints?.filename ?? s.title;
    if (!url || typeof filename !== 'string' || !filename || seen.has(filename)) return [];
    seen.add(filename);
    const a = s.attributes ?? {};
    const texts = (value: unknown) => Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
    return [{ filename, url, label: typeof a.label === 'string' && a.label ? a.label : filename,
      cached: typeof a.cached === 'boolean' ? a.cached : undefined,
      seeders: Number.isFinite(a.seeders) && a.seeders >= 0 ? a.seeders : undefined,
      size: Number.isFinite(a.sizeBytes) && a.sizeBytes > 0 ? a.sizeBytes : undefined,
      badges: [a.resolution === '2160p' ? '4K' : a.resolution, a.dolbyVision ? 'Dolby Vision' : '',
        a.hdrFormat || (a.hdr ? 'HDR' : ''), a.source, a.audio, a.hardcodedSubs ? 'Hardcoded subtitles' : '', a.threeD ? '3D' : '']
        .filter((s): s is string => typeof s === 'string' && s.length > 0),
      languages: texts(a.audioLanguages), probed: a.probed === true }];
  });
}

export async function fetchSources(addon: Addon, imdb: string, routes: Routes, season?: number, episode?: number,
  signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<TitleSource[] | null> {
  try {
    const id = season !== undefined && episode !== undefined ? `${imdb}:${season}:${episode}` : imdb;
    const response = await fetchImpl(`${addon.base}/stream/${season === undefined ? 'movie' : 'series'}/${encodeURIComponent(id)}.json`, { signal });
    return response.ok ? parseSources(await response.json(), addon, routes) : null;
  } catch { return null; }
}

export type Preparation = { state: 'ready' | 'preparing' | 'not-queued' | 'failed' | 'unknown'; progress?: number; message?: string };

export async function prepareSource(url: string, queue: boolean, fetchImpl: typeof fetch = fetch): Promise<Preparation> {
  // Only URLs validated by scoutTicket belong here; refuse a caller supplying a different origin or route.
  if (!/^\/scout\/(?:p\/[\w.~%-]+|(?:[\w.~%-]+\/)?play\/[\w.~%-]+)(?:\?[^#]*)?$/.test(url)) return { state: 'failed' };
  const target = new URL(url, globalThis.location?.origin ?? 'https://den.invalid');
  if (!queue) target.searchParams.set('probe', '1');
  try {
    const response = await fetchImpl(target.pathname + target.search, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(20000) });
    // A manual redirect is intentionally opaque in browsers. It means Scout has a ready media URL;
    // following it would download a movie into JS just to learn whether it was ready.
    if (response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400 || response.status === 200) {
      await response.body?.cancel(); return { state: 'ready' };
    }
    const body = await response.json().catch(() => ({}));
    if (response.status === 202) return { state: 'preparing', progress: Number.isFinite(body.progress) ? Math.max(0, Math.min(1, body.progress)) : undefined };
    if (body.error === 'not_queued') return { state: 'not-queued' };
    if (response.status === 404 || response.status === 410) return { state: 'failed', message: 'This source is no longer available.' };
    return { state: 'unknown', message: 'Couldn’t check the download. Try again shortly.' };
  } catch { return { state: 'unknown', message: 'Couldn’t reach the download service.' }; }
}
