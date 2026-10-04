// den-edge's own request log sees nothing of what happens once the app has loaded: a page that broke or never
// rendered, how a playback session ended, a cast or AirPlay attempt. These three reports join
// `startupReport.ts`'s precedent (den-edge#234): POST a small, typed body to `den-edge/diagnostics.rs`, answered
// with no content and logged as one tagged line. Never a title, a URL, a token or any other free text — enums and
// capped numbers only, so a malformed or hostile body is a 400, never a line in the log.

import { parseRoute, type Route } from './route';

// ---- The release this page is running (den-edge's `x-den-release` on the shell, `web.rs`'s `release()`) ----

let release: string | undefined;

/**
 * A HEAD re-fetch of this page's own path, read once, early (called from `main.ts`): den-edge stamps every shell
 * response with `x-den-release`, the shell's own digest, but a browser has no way to read a header of the
 * navigation it is already showing — only of a request it makes itself. Reading it now, rather than lazily when
 * the first report needs it, is what keeps it naming the release this page actually loaded rather than one den-
 * edge has since moved on to.
 */
export async function loadRelease(
  fetchImpl: typeof fetch = fetch,
  path: string = typeof location === 'undefined' ? '/' : location.pathname,
): Promise<void> {
  try {
    const res = await fetchImpl(path, { method: 'HEAD', cache: 'no-store' });
    release = res.headers.get('x-den-release') ?? undefined;
  } catch {
    // Left unset: a report sent before this resolves, or one that never does, just omits `release`.
  }
}

/** For a report built before `loadRelease` resolves (an error in the first moment of a load, say). */
export function currentRelease(): string | undefined {
  return release;
}

// ---- Shared transport ----

function post(url: string, body: unknown, fetchImpl: typeof fetch): void {
  void fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => undefined);
}

/**
 * Fire-and-forget, `sendBeacon` first: a report sent as the tab hides or unloads must outrun the very navigation
 * it is reporting on, which a `fetch` already in flight is not guaranteed to. Falls back to `fetch(…,
 * {keepalive: true})` where `sendBeacon` is absent or refuses (over its own small body-size limit, say — never a
 * concern for a body this shape).
 */
function beacon(url: string, body: unknown, fetchImpl: typeof fetch): void {
  const text = JSON.stringify(body);
  if (typeof navigator !== 'undefined' && navigator.sendBeacon?.(url, text)) return;
  post(url, body, fetchImpl);
}

// ---- Page errors (`POST /playback/page-error`) ----

export type PageErrorKind = 'uncaught' | 'unhandled_rejection' | 'chunk_load' | 'render_stall';
export type Module =
  'app' | 'player' | 'billboard' | 'row' | 'settings' | 'cast' | 'router' | 'other';
export type RouteKind = 'home' | 'title' | 'settings' | 'other';

/** Which kind of page `route` is, never the page itself: a title's id or a search's query must not reach the log. */
export function routeKindOf(route: Route | null | undefined): RouteKind {
  switch (route?.page) {
    case 'library':
      return 'home';
    case 'title':
      return 'title';
    case 'settings':
      return 'settings';
    default:
      return 'other';
  }
}

/** The app route the page this script runs in is on right now, for a report built outside the router. */
export function currentRouteKind(
  path: string = typeof location === 'undefined' ? '/' : location.pathname + location.search,
): RouteKind {
  try {
    return routeKindOf(parseRoute(path));
  } catch {
    return 'other';
  }
}

const MODULE_FILES: readonly Module[] = [
  'player',
  'billboard',
  'row',
  'settings',
  'cast',
  'router',
];

/**
 * The stack's first app-source frame's file name, against a fixed allowlist — never the frame itself, which may
 * carry a full path or a query string a production build appends for cache-busting. A built bundle's chunk
 * names are usually hashed and so match nothing here, which is fine: `other` is as true an answer as this method
 * can give then, and still never free text.
 */
export function moduleOf(stack: string | undefined): Module {
  const frame = stack
    ?.split('\n')
    .map((line) => /([A-Za-z0-9_-]+)\.(?:ts|svelte|js)(?:[:?]|$)/.exec(line)?.[1])
    .find((name): name is string => name !== undefined);
  const name = frame?.toLowerCase();
  if (name === 'app' || name === 'main') return 'app';
  if (name === 'routepage' || name === 'navigation') return 'router';
  const found = MODULE_FILES.find((m) => name === m || (m === 'row' && name?.endsWith('row')));
  return found ?? 'other';
}

export interface PageErrorReport {
  kind: PageErrorKind;
  module: Module;
  /** Absent when `loadRelease` hasn't resolved yet. */
  release?: string;
  route: RouteKind;
}

export function sendPageError(report: PageErrorReport, fetchImpl: typeof fetch = fetch): void {
  post('/playback/page-error', report, fetchImpl);
}

/** A `PageErrorReport` for `kind`, filling in the release and route this call stands at. */
export function pageError(kind: PageErrorKind, module: Module): PageErrorReport {
  return { kind, module, release: currentRelease(), route: currentRouteKind() };
}

// ---- A playback session's outcome (`POST /playback/outcome`) ----

export type Engine = 'native' | 'hls.js' | 'progressive';
export type NetworkRoute = 'lan' | 'public' | 'tailnet';
export type EndReason = 'finished' | 'user_exit' | 'error';
export type HlsFatalType = 'networkError' | 'mediaError' | 'muxError' | 'otherError';
export type HlsFatalDetail =
  | 'bufferStalledError'
  | 'bufferSeekOverHole'
  | 'bufferNudgeOnStall'
  | 'fragLoadError'
  | 'fragLoadTimeOut'
  | 'manifestLoadError'
  | 'manifestLoadTimeOut'
  | 'levelLoadError'
  | 'keyLoadError'
  | 'other';
export type SubtitleSource = 'release' | 'den_subtitles';

const HLS_FATAL_DETAILS: readonly HlsFatalDetail[] = [
  'bufferStalledError',
  'bufferSeekOverHole',
  'bufferNudgeOnStall',
  'fragLoadError',
  'fragLoadTimeOut',
  'manifestLoadError',
  'manifestLoadTimeOut',
  'levelLoadError',
  'keyLoadError',
];

/** hls.js's own `details` string, narrowed to the curated set den-edge's allowlist takes; anything else hls.js
 * names (it has dozens) is sent as `other` rather than as its own free text. */
export function hlsFatalDetail(details: string | undefined): HlsFatalDetail | undefined {
  if (details === undefined) return undefined;
  return HLS_FATAL_DETAILS.includes(details as HlsFatalDetail)
    ? (details as HlsFatalDetail)
    : 'other';
}

const HLS_FATAL_TYPES: readonly HlsFatalType[] = [
  'networkError',
  'mediaError',
  'muxError',
  'otherError',
];

/** hls.js's own `ErrorTypes` value — a closed set of four — narrowed the same way as `hlsFatalDetail`. */
export function hlsFatalTypeOf(type: string | undefined): HlsFatalType | undefined {
  if (type === undefined) return undefined;
  return HLS_FATAL_TYPES.includes(type as HlsFatalType) ? (type as HlsFatalType) : 'otherError';
}

/** `Player.svelte`'s `broke()` folds an hls.js fatal error into one string (`hls.js <type> <details>`), the same
 * shape the cast page's own failures relay through `den-error`: parsed back here rather than threading the
 * structured pair through every path that can call `broke`. */
export function hlsFatalFromMessage(
  message: string,
): { type: HlsFatalType; detail: HlsFatalDetail } | undefined {
  const match = /^hls\.js (\S+) (\S+)$/.exec(message);
  if (!match) return undefined;
  const type = hlsFatalTypeOf(match[1]);
  const detail = hlsFatalDetail(match[2]);
  return type && detail ? { type, detail } : undefined;
}

/** A subtitle language, narrowed to the short shape den-edge's allowlist takes (lowercase letters and hyphens,
 * 2–8 characters); anything else — absent, or a shape it refuses — is left out rather than sent and rejected. */
export function reportableLanguage(language: string | null | undefined): string | undefined {
  if (!language) return undefined;
  const lower = language.toLowerCase();
  return /^[a-z-]{2,8}$/.test(lower) ? lower : undefined;
}

export interface PlaybackOutcomeReport {
  engine: Engine;
  route: NetworkRoute;
  stallCount: number;
  stalledMs: number;
  endReason: EndReason;
  errorCode?: number;
  hlsFatalType?: HlsFatalType;
  hlsFatalDetail?: HlsFatalDetail;
  secondsPlayed: number;
  subtitleLanguage?: string;
  subtitleSource?: SubtitleSource;
  subtitleSwitched?: boolean;
  subtitleTurnedOff?: boolean;
  subtitleLoadFailed?: boolean;
}

/** `sendBeacon` first (`beacon`): a session's outcome is as likely to be sent from a page hiding or unloading as
 * from one still open. */
export function sendPlaybackOutcome(
  report: PlaybackOutcomeReport,
  fetchImpl: typeof fetch = fetch,
): void {
  beacon('/playback/outcome', report, fetchImpl);
}

// ---- A cast or AirPlay attempt (`POST /playback/cast`) ----

export type CastKind = 'chromecast' | 'airplay';
export type CastStage = 'offered' | 'attempted' | 'started';
export type CastFailReason =
  'receiver_not_loaded' | 'media_error' | 'lan_unreachable' | 'session_error' | 'other';

export interface CastReport {
  kind: CastKind;
  reached: CastStage;
  failed?: boolean;
  failReason?: CastFailReason;
  sessionSecs?: number;
}

export function sendCastReport(report: CastReport, fetchImpl: typeof fetch = fetch): void {
  beacon('/playback/cast', report, fetchImpl);
}
