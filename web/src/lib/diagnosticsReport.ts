// den-edge's own request log sees nothing of what happens once the app has loaded: a page that broke or never
// rendered, how a playback session ended, a cast or AirPlay attempt. These three reports join
// `startupReport.ts`'s precedent (den-edge#234): POST a small, typed body to `den-edge/diagnostics.rs`, answered
// with no content and logged as one tagged line. Never a title, a URL, a token or any other free text — enums and
// capped numbers only, so a malformed or hostile body is a 400, never a line in the log.

import { parseRoute, type Route } from './route';

// ---- The release this page is running (den-edge's `x-den-release` on the shell, `web.rs`'s `release()`) ----

let release: string | undefined;

/**
 * Read the release of the navigation this page is actually running from its Server-Timing entry. Older servers
 * and browsers fall back to one early HEAD of this page's own path and its `x-den-release`; doing that here,
 * rather than lazily when the first report needs it, keeps that fallback's deployment race as small as possible.
 */
export async function loadRelease(
  fetchImpl: typeof fetch = fetch,
  path: string = typeof location === 'undefined' ? '/' : location.pathname,
  performanceImpl: Pick<Performance, 'getEntriesByType'> | undefined = globalThis.performance,
): Promise<string | undefined> {
  const navigation = performanceImpl?.getEntriesByType('navigation')[0] as
    PerformanceNavigationTiming | undefined;
  const navigated = navigation?.serverTiming.find(
    ({ name }) => name === 'den-release',
  )?.description;
  if (navigated) {
    release = navigated;
    return release;
  }
  try {
    const res = await fetchImpl(path, { method: 'HEAD', cache: 'no-store' });
    release = res.headers.get('x-den-release') ?? undefined;
    return release;
  } catch {
    // Left unset: a report sent before this resolves, or one that never does, just omits `release`.
    return undefined;
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
 * The stack's first app-source frame's file name, exactly as it was written there — never the frame itself,
 * which may carry a full path or a query string a production build appends for cache-busting. `moduleOf` lower-
 * cases this against a fixed allowlist; `chunkOf` keeps the case, for the built chunk's own name.
 */
function firstFrameFile(stack: string | undefined): string | undefined {
  return stack
    ?.split('\n')
    .map((line) => /([A-Za-z0-9_-]+)\.(?:ts|svelte|js)(?:[:?]|$)/.exec(line)?.[1])
    .find((name): name is string => name !== undefined);
}

/**
 * The stack's first app-source frame's file name, against a fixed allowlist. A built bundle's chunk names are
 * usually hashed and so match nothing here, which is fine: `other` is as true an answer as this method can give
 * then, and still never free text.
 */
export function moduleOf(stack: string | undefined): Module {
  const name = firstFrameFile(stack)?.toLowerCase();
  if (name === 'app' || name === 'main') return 'app';
  if (name === 'routepage' || name === 'navigation') return 'router';
  const found = MODULE_FILES.find((m) => name === m || (m === 'row' && name?.endsWith('row')));
  return found ?? 'other';
}

/**
 * The built chunk this stack's first app-source frame names, once a production build's content hash is
 * stripped (`Library-a1b2c3d4.js` → `Library`) — one of the app's own page or component chunks, which this
 * build names in PascalCase; a vendor or runtime chunk's own lowercase name fails the check and is left out,
 * same as any frame whose name doesn't fit at all. Never the frame's full path, a query string, or free text:
 * the shape check both is this method's allowlist and bounds its length.
 */
export function chunkOf(stack: string | undefined): string | undefined {
  const frame = firstFrameFile(stack);
  if (!frame) return undefined;
  const base = frame.replace(/-[0-9a-fA-F]{6,12}$/, '');
  return /^[A-Z][A-Za-z0-9]{0,31}$/.test(base) ? base : undefined;
}

/** A closed read of `error`'s real constructor — never its (freely settable) `message` or `.name` string, and
 * never a URL. `DOMException` covers every one of its named variants but `NetworkError`, called out on its own
 * as the one a fetch or a media element's own network failure actually throws. */
export type ErrorKind =
  | 'TypeError'
  | 'ReferenceError'
  | 'RangeError'
  | 'SyntaxError'
  | 'DOMException'
  | 'NetworkError'
  | 'other';

export function errorKindOf(error: unknown): ErrorKind {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'NetworkError' ? 'NetworkError' : 'DOMException';
  }
  if (error instanceof TypeError) return 'TypeError';
  if (error instanceof ReferenceError) return 'ReferenceError';
  if (error instanceof RangeError) return 'RangeError';
  if (error instanceof SyntaxError) return 'SyntaxError';
  return 'other';
}

export interface PageErrorReport {
  kind: PageErrorKind;
  module: Module;
  /** The error's real constructor (`errorKindOf`); absent for a report with no caught error to read one from
   * (`render_stall`, `chunk_load`). */
  errorKind?: ErrorKind;
  /** The built chunk the error's first stack frame names (`chunkOf`); absent where none matched. */
  chunk?: string;
  /** Absent when `loadRelease` hasn't resolved yet. */
  release?: string;
  route: RouteKind;
}

export function sendPageError(report: PageErrorReport, fetchImpl: typeof fetch = fetch): void {
  post('/playback/page-error', report, fetchImpl);
}

/** A `PageErrorReport` for `kind`, filling in the release and route this call stands at, and — from `error`,
 * where the caller caught one — its real constructor and the chunk its first stack frame names. */
export function pageError(kind: PageErrorKind, module: Module, error?: unknown): PageErrorReport {
  const stack = error instanceof Error ? error.stack : undefined;
  return {
    kind,
    module,
    errorKind: error !== undefined ? errorKindOf(error) : undefined,
    chunk: chunkOf(stack),
    release: currentRelease(),
    route: currentRouteKind(),
  };
}

// ---- Identity: what was played (`LOG_IDENTITY`, den-edge's own switch — never asked here) ----
//
// Carried on the outcome, cast and startup reports alike, so the three share one shape. den-edge drops the whole
// group from its log when its switch is off, and drops `release` alone when its name fails den-edge's own shape
// there — so nothing here needs to validate or gate anything itself; it only reports what the player already
// knows. Never a URL, a token or a library id.

export type MediaTypeReport = 'movie' | 'tv';
/** den-remux always re-encodes a browser session's audio to AAC (`remux.ts`'s `Session`). */
export type AudioCodecReport = 'aac';

export interface ReleaseIdentity {
  name: string;
  size: number;
}

export interface IdentityFields {
  tmdbId?: number;
  mediaType?: MediaTypeReport;
  season?: number;
  episode?: number;
  release?: ReleaseIdentity;
  audioTrackIndex?: number;
  audioLanguage?: string;
  audioCodec?: AudioCodecReport;
  subtitleIndex?: number;
  subtitleLanguage?: string;
  subtitleSource?: SubtitleSource;
}

/**
 * The identity fields a report may carry, built from the title on screen and den-remux's own session —
 * `Player.svelte`'s own state, never fetched here. `session` is `undefined` when nothing has opened yet (a
 * report sent before `begin()` got anywhere), in which case only the title itself is named.
 */
export function identityOf(
  title: { id: number; type: MediaTypeReport },
  season: number | undefined,
  episode: number | undefined,
  session:
    | {
        release: { filename: string; size: number };
        audioTrack: number;
        audioLanguage?: string | null;
      }
    | undefined,
  subtitle: { index?: number; language?: string; source?: SubtitleSource } = {},
): IdentityFields {
  const fields: IdentityFields = { tmdbId: title.id, mediaType: title.type, season, episode };
  if (session) {
    fields.release = { name: session.release.filename, size: session.release.size };
    fields.audioTrackIndex = session.audioTrack;
    const audioLanguage = reportableLanguage(session.audioLanguage);
    if (audioLanguage) fields.audioLanguage = audioLanguage;
    fields.audioCodec = 'aac';
  }
  // `-1` is `Array.prototype.findIndex`'s own "not found", which every caller gets by passing its raw result
  // straight through rather than filtering it out itself.
  if (subtitle.index !== undefined && subtitle.index >= 0) fields.subtitleIndex = subtitle.index;
  const subtitleLanguage = reportableLanguage(subtitle.language);
  if (subtitleLanguage) fields.subtitleLanguage = subtitleLanguage;
  if (subtitle.source) fields.subtitleSource = subtitle.source;
  return fields;
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
export type SubtitleSource = 'release' | 'den_subtitles' | 'unknown';

/**
 * Why, if at all, this visit moved to another release before it ended: the decoder refusing what played
 * (`decode`), the link not carrying it (`delivery`), or the viewer's own pick from the release list (`user`).
 * Absent on the report when none did. A closed set, never the releases themselves, so a visit like Fauda's own
 * (den-edge#275) is answerable from the log without guessing which the player meant.
 */
export type SwitchReason = 'decode' | 'delivery' | 'user';

/**
 * What a report can honestly say served the subtitle actually showing. den-remux decides, per rendition
 * language, whether the release's own track beats a den-subtitles candidate it was offered for the session —
 * and never says which won (`Session::subtitle_used` is den-remux's own, for its log line only) — so a
 * session that offered a candidate cannot be told apart, from here, from one that used it. `release` only
 * when no den-subtitles candidate was offered this session at all, the one case with just one possible
 * source; `unknown` when one was offered; absent when no subtitle is showing.
 */
export function subtitleSourceOf(
  candidateOffered: boolean,
  shown: boolean,
): SubtitleSource | undefined {
  if (!shown) return undefined;
  return candidateOffered ? 'unknown' : 'release';
}

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

export interface PlaybackOutcomeReport extends IdentityFields {
  engine: Engine;
  route: NetworkRoute;
  stallCount: number;
  stalledMs: number;
  endReason: EndReason;
  errorCode?: number;
  hlsFatalType?: HlsFatalType;
  hlsFatalDetail?: HlsFatalDetail;
  secondsPlayed: number;
  subtitleSwitched?: boolean;
  subtitleTurnedOff?: boolean;
  subtitleLoadFailed?: boolean;
  /** How many times this visit moved to another release, by any `SwitchReason`; absent where it never did. */
  switchCount?: number;
  /** The last switch's own reason; absent alongside `switchCount` when there was none. */
  lastSwitchReason?: SwitchReason;
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

export interface CastReport extends IdentityFields {
  kind: CastKind;
  reached: CastStage;
  failed?: boolean;
  failReason?: CastFailReason;
  sessionSecs?: number;
}

export function sendCastReport(report: CastReport, fetchImpl: typeof fetch = fetch): void {
  beacon('/playback/cast', report, fetchImpl);
}
