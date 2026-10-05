import type { Addon } from './scout';
import { releaseIdentity } from './downloadRows';
import { relayFetch } from './relayFetch';
import { within, type Routes } from './routes';
import { retryAfterMs } from './retryAfter';

export interface TitleSource {
  filename: string;
  url: string;
  label: string;
  cached?: boolean;
  seeders?: number;
  /** The file this source actually plays — an episode's own size, never a season pack's (scout corrects
   *  it once it has probed the resolved file). */
  size?: number;
  /** The season pack this episode came from, present only when scout knows it differs meaningfully from
   *  `size` — context for the size shown, never a number to rank or filter on. */
  packSize?: number;
  badges: string[];
  languages: string[];
  probed: boolean;
  /** What makes it this release across resolves (`releaseIdentity`), as the TV names it. */
  identity: string;
  /** scout's `attributes` as sent: what den-core's `rank_releases` ranks it by. */
  attributes: Record<string, unknown>;
}

/** The releases as `rank_releases` takes them: scout's attributes, with each one's identity. */
export const rankable = (sources: TitleSource[]) =>
  sources.map((source) => ({ ...source.attributes, identity: source.identity }));

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
    const a = s.attributes && typeof s.attributes === 'object' ? s.attributes : {};
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
        packSize:
          Number.isFinite(a.packSizeBytes) && a.packSizeBytes > 0 ? a.packSizeBytes : undefined,
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
        identity: releaseIdentity(s.url, s.behaviorHints?.filename),
        attributes: a,
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

/** What the debrid itself says about a fetch, as scout's `202` passes it on. */
export interface DebridFetch {
  state?: 'queued' | 'fetching' | 'downloading' | 'stalled' | 'failed';
  seeds?: number;
  peers?: number;
  service?: string;
}

/**
 * What scout said about a release. `failed` is a plain 404 (the release is gone), `expired` a lapsed play ticket (a
 * fact about the URL: a fresh resolve mints another), `refused` the debrid turning the request away, `paused` a
 * prefetch held back so Play keeps the hour's last adds (asked again at `until`).
 */
export type Preparation = {
  state:
    'ready' | 'preparing' | 'not-queued' | 'failed' | 'expired' | 'refused' | 'paused' | 'unknown';
  progress?: number;
  etaSeconds?: number;
  bytesPerSecond?: number;
  fetch?: DebridFetch;
  /** The debrid that refused (`refused`). */
  service?: string;
  /** When a held-back add may be made again, in ms (`paused`). */
  until?: number;
  message?: string;
};

const SCOUT_URL = /^\/scout\/(?:p\/[\w.~%-]+|(?:[\w.~%-]+\/)?play\/[\w.~%-]+)(?:\?[^#]*)?$/;
const FETCH_STATES = new Set(['queued', 'fetching', 'downloading', 'stalled', 'failed']);
const count = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;

/** The debrid's account in a `202` body; undefined when scout sent none of it. */
function debridFetch(body: Record<string, unknown>): DebridFetch | undefined {
  const fetch: DebridFetch = {
    state: FETCH_STATES.has(body.state as string)
      ? (body.state as DebridFetch['state'])
      : undefined,
    seeds: count(body.seeds),
    peers: count(body.peers),
    service: typeof body.service === 'string' && body.service ? body.service : undefined,
  };
  return Object.values(fetch).some((v) => v !== undefined) ? fetch : undefined;
}

/**
 * Ask scout about a release: `queue` asks it to start fetching (with `prefetch`, an add nobody is waiting on, which
 * scout holds back while the hour's last adds are kept for Play); otherwise a read-only probe (`?probe=1`).
 */
export async function prepareSource(
  url: string,
  queue: boolean,
  fetchImpl: typeof fetch = relayFetch,
  prefetch = false,
): Promise<Preparation> {
  // Only URLs validated by scoutTicket belong here; refuse a caller supplying a different origin or route.
  if (!SCOUT_URL.test(url)) return { state: 'failed' };
  const target = new URL(url, globalThis.location?.origin ?? 'https://den.invalid');
  if (!queue) target.searchParams.set('probe', '1');
  else if (prefetch) target.searchParams.set('prefetch', '1');
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
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const number = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    if (response.status === 202) {
      const progress = number(body.progress);
      const eta = number(body.etaSeconds);
      const rate = number(body.bytesPerSecond);
      return {
        state: 'preparing',
        progress: progress === undefined ? undefined : Math.max(0, Math.min(1, progress)),
        etaSeconds: eta === undefined ? undefined : Math.round(eta),
        bytesPerSecond: rate === undefined ? undefined : Math.round(rate),
        fetch: debridFetch(body),
      };
    }
    if (body.error === 'not_queued') return { state: 'not-queued' };
    if (body.error === 'ticket_expired') return { state: 'expired' };
    if (response.status === 404 || response.status === 410)
      return { state: 'failed', message: 'This source is no longer available.' };
    if (response.status === 503 && body.error === 'reserved_for_play')
      return { state: 'paused', until: Date.now() + retryAfterMs(response, 15 * 60_000) };
    if (response.status === 503)
      return {
        state: 'refused',
        service: typeof body.service === 'string' ? body.service : undefined,
      };
    return { state: 'unknown', message: 'Couldn’t check the download. Try again shortly.' };
  } catch {
    return { state: 'unknown', message: 'Couldn’t reach the download service.' };
  }
}

/** A preparation as den-core's `download_status` takes an answer (den-spec library-v4 §17). */
export function answerOf(preparation: Preparation): Record<string, unknown> {
  switch (preparation.state) {
    case 'ready':
      return { kind: 'ready' };
    case 'preparing':
      return {
        kind: 'preparing',
        progress: preparation.progress,
        etaSeconds: preparation.etaSeconds,
        bytesPerSecond: preparation.bytesPerSecond,
        fetch: preparation.fetch,
      };
    case 'not-queued':
      return { kind: 'not_queued' };
    case 'failed':
      return { kind: 'dead' };
    case 'expired':
      return { kind: 'ticket_expired' };
    case 'refused':
      return { kind: 'service_unavailable', service: preparation.service };
    case 'paused':
      return { kind: 'reserved_for_play', until: preparation.until ?? Date.now() };
    default:
      return { kind: 'unknown' };
  }
}

/**
 * Cancel a release at the debrid, or with `reannounce` ask it to look for peers again (den#204: `DELETE` on the play
 * URL). Best effort: scout declines what it didn't add or has finished, and nothing here waits on it.
 */
export async function cancelSource(
  url: string,
  reannounce = false,
  fetchImpl: typeof fetch = relayFetch,
): Promise<boolean> {
  if (!SCOUT_URL.test(url)) return false;
  const target = new URL(url, globalThis.location?.origin ?? 'https://den.invalid');
  if (reannounce) target.searchParams.set('op', 'reannounce');
  try {
    const response = await fetchImpl(target.pathname + target.search, {
      method: 'DELETE',
      signal: AbortSignal.timeout(20000),
    });
    return response.ok || [404, 409, 501].includes(response.status);
  } catch {
    return false;
  }
}
