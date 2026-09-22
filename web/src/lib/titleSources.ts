import type { Addon } from './scout';
import { relayFetch } from './relayFetch';
import { within, type Routes } from './routes';

export interface TitleSource {
  filename: string;
  url: string;
  label: string;
  cached?: boolean;
  seeders?: number;
  size?: number;
  badges: string[];
  languages: string[];
  probed: boolean;
}

/** Playback tickets stay on our Scout relay. Never follow the media redirect while queuing a download. */
export function scoutTicket(url: string, addon: Addon, routes: Routes): string | null {
  const suffix = within(url, [
    ...(routes.play ?? []),
    ...(routes.scout ?? []),
    { url: addon.install },
  ]);
  if (!suffix || !/^\/(?:p\/[\w.~%-]+|(?:[\w.~%-]+\/)?play\/[\w.~%-]+)(?:\?[^#]*)?$/.test(suffix))
    return null;
  if (url.startsWith(addon.install + '/') && suffix.startsWith('/play/'))
    return addon.base + suffix;
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
    const texts = (value: unknown) =>
      Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
    return [
      {
        filename,
        url,
        label: typeof a.label === 'string' && a.label ? a.label : filename,
        cached: typeof a.cached === 'boolean' ? a.cached : undefined,
        seeders: Number.isFinite(a.seeders) && a.seeders >= 0 ? a.seeders : undefined,
        size: Number.isFinite(a.sizeBytes) && a.sizeBytes > 0 ? a.sizeBytes : undefined,
        badges: [
          a.resolution === '2160p' ? '4K' : a.resolution,
          a.dolbyVision ? 'Dolby Vision' : '',
          a.hdrFormat || (a.hdr ? 'HDR' : ''),
          a.source,
          a.audio,
          a.hardcodedSubs ? 'Hardcoded subtitles' : '',
          a.threeD ? '3D' : '',
        ].filter((s): s is string => typeof s === 'string' && s.length > 0),
        languages: texts(a.audioLanguages),
        probed: a.probed === true,
      },
    ];
  });
}

/**
 * What scout says about its own list (its `den` object): whether an empty list means nothing exists (`empty`) or
 * that it could not ask every source (`unknown`), whether a list may be short (`partial`), and whether it is a
 * held list served because no source answered (`outage`, with the time it was built). Absent from an older scout.
 */
export interface SourceAnswer {
  kind: 'live' | 'partial' | 'empty' | 'unknown' | 'stale';
  /** Sources that could have been asked and did not answer. */
  missing: number;
  /** A held list served in an outage, and when it was built (ms). */
  outage?: { builtAt: number };
}

const answerKinds = new Set(['live', 'partial', 'empty', 'unknown', 'stale']);
// A source that answered, or that can never be asked, is not one the list is waiting on.
const notMissing = new Set(['answered', 'skipped_misconfigured', 'quarantined']);

export function parseAnswer(body: unknown): SourceAnswer | undefined {
  const den = (body as { den?: unknown } | null)?.den as
    | {
        answerKind?: unknown;
        degraded?: unknown;
        generatedAt?: unknown;
        coverage?: { sources?: unknown };
      }
    | undefined;
  if (!den || typeof den !== 'object' || !answerKinds.has(den.answerKind as string))
    return undefined;
  const sources: unknown[] = Array.isArray(den.coverage?.sources) ? den.coverage.sources : [];
  const builtAt = typeof den.generatedAt === 'string' ? Date.parse(den.generatedAt) : NaN;
  return {
    kind: den.answerKind as SourceAnswer['kind'],
    missing: sources.filter(
      (s) => !notMissing.has((s as { outcome?: unknown } | null)?.outcome as string),
    ).length,
    outage: den.degraded === 'stale_list' && Number.isFinite(builtAt) ? { builtAt } : undefined,
  };
}

/** Scout's list for a title and what it says about it; `sources` is null when scout could not be reached. */
export async function fetchSourceList(
  addon: Addon,
  imdb: string,
  routes: Routes,
  season?: number,
  episode?: number,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = relayFetch,
): Promise<{ sources: TitleSource[] | null; answer?: SourceAnswer }> {
  try {
    const id =
      season !== undefined && episode !== undefined ? `${imdb}:${season}:${episode}` : imdb;
    const response = await fetchImpl(
      `${addon.base}/stream/${season === undefined ? 'movie' : 'series'}/${encodeURIComponent(id)}.json`,
      { signal },
    );
    if (!response.ok) return { sources: null };
    const body: unknown = await response.json();
    return { sources: parseSources(body, addon, routes), answer: parseAnswer(body) };
  } catch {
    return { sources: null };
  }
}

export async function fetchSources(
  ...args: Parameters<typeof fetchSourceList>
): Promise<TitleSource[] | null> {
  return (await fetchSourceList(...args)).sources;
}

/** "5 min", "3 h", "2 days": how long ago a held list was built. */
export function ageOf(builtAt: number, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((now - builtAt) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

export type Preparation = {
  state: 'ready' | 'preparing' | 'not-queued' | 'failed' | 'unknown';
  progress?: number;
  message?: string;
};

export async function prepareSource(
  url: string,
  queue: boolean,
  fetchImpl: typeof fetch = relayFetch,
): Promise<Preparation> {
  // Only URLs validated by scoutTicket belong here; refuse a caller supplying a different origin or route.
  if (!/^\/scout\/(?:p\/[\w.~%-]+|(?:[\w.~%-]+\/)?play\/[\w.~%-]+)(?:\?[^#]*)?$/.test(url))
    return { state: 'failed' };
  const target = new URL(url, globalThis.location?.origin ?? 'https://den.invalid');
  if (!queue) target.searchParams.set('probe', '1');
  try {
    const response = await fetchImpl(target.pathname + target.search, {
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
    });
    // A manual redirect is intentionally opaque in browsers. It means Scout has a ready media URL;
    // following it would download a movie into JS just to learn whether it was ready.
    if (
      response.type === 'opaqueredirect' ||
      (response.status >= 300 && response.status < 400) ||
      response.status === 200
    ) {
      await response.body?.cancel();
      return { state: 'ready' };
    }
    const body = await response.json().catch(() => ({}));
    if (response.status === 202)
      return {
        state: 'preparing',
        progress: Number.isFinite(body.progress)
          ? Math.max(0, Math.min(1, body.progress))
          : undefined,
      };
    if (body.error === 'not_queued') return { state: 'not-queued' };
    if (response.status === 404 || response.status === 410)
      return { state: 'failed', message: 'This source is no longer available.' };
    return { state: 'unknown', message: 'Couldn’t check the download. Try again shortly.' };
  } catch {
    return { state: 'unknown', message: 'Couldn’t reach the download service.' };
  }
}
