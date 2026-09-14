// Playback in this browser through den-remux (oxyc/den-remux, issue #11): it copies the video, makes the audio AAC
// and serves HLS. This page names the title and the library's scout install; den-remux picks a cached release it can
// play, and keeps scout's tickets and the debrid's links to itself. Its routes are on this origin under /remux
// (tailscale serve), and a cookie from a one-time browser key lets this browser start sessions.

import type { Playable } from './playable';
import { retryAfterMs } from './retryAfter';
import type { Entry } from './routes';

export interface Session {
  /** `/remux/s/<sid>/<sig>/master.m3u8`: a signed URL, so AirPlay can play it too. */
  playlist: string;
  /** Seconds. */
  duration: number;
  release: { label: string; filename: string; size: number };
  /** What plays: the codec, the size it plays at, and whether den-remux converted and tone-mapped it. */
  video?: {
    codec: string;
    transcoded: boolean;
    width?: number;
    height?: number;
    tonemapped?: boolean;
  };
  /** The audio track playing, by index into `audioTracks`: one per session, re-encoded to AAC. */
  audioTrack: number;
  /** The channels the session's audio carries; absent from a den-remux before it said so. */
  audioChannels?: number;
  audioTracks: AudioTrack[];
}

export interface AudioTrack {
  language?: string | null;
  name?: string | null;
  channels: number;
  commentary: boolean;
}

export interface Want {
  imdb: string;
  season?: number;
  episode?: number;
  /** Scout's install URL from the library. */
  scout: string;
  /** Install URLs that may be den-subtitles', tried in turn: only den-remux can tell which is. */
  subtitles: string[];
  subtitleLanguages: string[];
  /** The player's languages, most wanted first. */
  audio: string[];
  /** What this browser decodes: `h264`, and `hevc` when it can — what a den-remux before `playable` reads. */
  videoCodecs: string[];
  /** What this browser decodes, level by level (`playable`), so den-remux converts only what won't play here. */
  playable?: Playable;
  /** Another track of an earlier session's release: its index there, and that release's filename. */
  audioTrack?: number;
  filename?: string;
  /** The second playback starts at, which den-remux names in the playlist (`EXT-X-START`) for a native player. */
  startAt?: number;
  /** Bits a second a session may need, away from home (`linkLimit`): den-remux picks a release, or a transcode, that fits. */
  maxBitrate?: number;
  /** The HLS player this page chose (`nativeHls`), for den-remux's session log. */
  player?: 'native' | 'hls.js';
}

export type Failure = 'login' | 'none' | 'busy' | 'transcode' | 'unreachable';

/** A refusal, and — when den-remux said so — how long it asked to be left alone for. */
export interface Refused {
  failure: Failure;
  /** From its `Retry-After`; absent when it named none, and the caller's own interval stands. */
  retryMs?: number;
}

/** A direct LAN/tailnet probe must finish even when an unreachable route silently drops packets. */
export const REMUX_PROBE_TIMEOUT_MS = 3_000;

// A cross-site remux cannot rely on cookies. Keep its short-lived signed credential in this page's
// memory, scoped to exactly the service that issued it; never persist the browser's login key.
const browserTokens = new Map<string, string>();
const browserBase = (base: string) =>
  new URL(base, globalThis.location?.href ?? 'https://den.invalid/').href.replace(/\/$/, '');

/** Forget page-local credentials (tests). */
export function forgetBrowserTokens(): void {
  browserTokens.clear();
}

function browserHeaders(base: string): Record<string, string> {
  const token = browserTokens.get(browserBase(base));
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function forgetRefusedToken(base: string, response: Response): void {
  if (response.status === 401) browserTokens.delete(browserBase(base));
}

/**
 * Where den-remux answers for this page: the first of its routes-table entries (den-spec routes-v1) this page can use
 * whose `/health` answers — none behind Access (a browser holds no token), and no plain http from an https page — or
 * null, off the tailnet where no address reaches it.
 */
export async function findRemux(
  entries: Entry[],
  fetchImpl: typeof fetch = fetch,
  secure = globalThis.location?.protocol !== 'http:',
): Promise<string | null> {
  for (const entry of entries) {
    if (entry.access || (secure && entry.url.startsWith('http:'))) continue;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('remux health deadline'));
      }, REMUX_PROBE_TIMEOUT_MS);
    });
    try {
      const probe = async () => {
        const res = await fetchImpl(`${entry.url}/health`, { signal: controller.signal });
        return res.ok && typeof ((await res.json()) as { status?: unknown }).status === 'string';
      };
      if (await Promise.race([probe(), expired])) return entry.url;
    } catch {
      // Out of reach from here, or not den-remux: the next.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** The bytes a link is timed over: past a connection's slow start, and a moment of the home upload. */
export const SPEED_PROBE_BYTES = 2 * 1024 * 1024;
/** The first of the transfer, after its first byte, that isn't counted: slow start, not the link. */
const SPEED_SKIP_MS = 150;
/** Time enough to measure a slow link by what arrived, rather than wait out all of it before playing. */
const SPEED_READ_MS = 4_000;
/** A probe that hasn't finished by then is given up on: playback goes ahead unmeasured. */
export const SPEED_DEADLINE_MS = 10_000;
/** How long a measured link is trusted before a session measures it again. */
export const LINK_TTL_MS = 10 * 60_000;
/** The share of the measured rate a session may need: room for the link to dip, and for what else uses it. */
const LINK_HEADROOM = 0.7;

/** Each den-remux's link, timed once and kept for LINK_TTL_MS: when it was asked, and the rate (null: not measured). */
const links = new Map<string, { at: number; rate: Promise<number | null> }>();

/** Forget the measured links (tests). */
export function forgetLinks(): void {
  links.clear();
}

/**
 * Whether den-remux at `base` is on the home network — a private IPv4 address or this machine, as the routes table's
 * LAN entry is — where there is no upload link between it and this browser to measure.
 */
export function onLan(
  base: string,
  page = globalThis.location?.href ?? 'https://den.invalid/',
): boolean {
  const host = new URL(base, page).hostname;
  return (
    host === 'localhost' ||
    /^(10|127)\.\d+\.\d+\.\d+$/.test(host) ||
    /^192\.168\.\d+\.\d+$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host)
  );
}

/**
 * The bits a second den-remux at `base` gets to this browser: its `/speed` timed from the first byte, less the first
 * SPEED_SKIP_MS, until the end or SPEED_READ_MS. Asked once per LINK_TTL_MS, sessions in between sharing the answer;
 * null when it couldn't be timed.
 */
export function measureLink(
  base: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = () => performance.now(),
): Promise<number | null> {
  const kept = links.get(base);
  if (kept && now() - kept.at < LINK_TTL_MS) return kept.rate;
  const rate = timeTransfer(base, fetchImpl, now);
  links.set(base, { at: now(), rate });
  return rate;
}

async function timeTransfer(
  base: string,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SPEED_DEADLINE_MS);
  let first: number | undefined;
  let mark: number | undefined;
  let last: number | undefined;
  let total = 0;
  let counted = 0;
  try {
    const res = await fetchImpl(`${base}/speed?bytes=${SPEED_PROBE_BYTES}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const at = now();
      first ??= at;
      last = at;
      total += value.byteLength;
      if (at - first <= SPEED_SKIP_MS) mark = at;
      else counted += value.byteLength;
      if (at - first >= SPEED_READ_MS) {
        void reader.cancel();
        break;
      }
    }
  } catch {
    // Given up on, or cut off: what arrived before still says something.
  } finally {
    clearTimeout(timer);
  }
  if (first === undefined || last === undefined) return null;
  // Past the skipped start where the transfer lasted that long; over the whole of it where it was faster than that.
  if (counted > 0 && mark !== undefined) return (counted * 8000) / (last - mark);
  return last > first ? (total * 8000) / (last - first) : null;
}

/**
 * The `maxBitrate` a session at `base` asks for: LINK_HEADROOM of the measured link, away from home; undefined at home,
 * and wherever the link couldn't be measured — den-remux then picks as it always has.
 */
export async function linkLimit(
  base: string,
  fetchImpl: typeof fetch = fetch,
  now?: () => number,
): Promise<number | undefined> {
  if (onLan(base)) return undefined;
  const rate = await measureLink(base, fetchImpl, now);
  return rate ? Math.round(rate * LINK_HEADROOM) : undefined;
}

/** Let this browser in with its key: true, false for a key den-remux doesn't know, null when it can't be reached. */
export async function login(
  key: string,
  fetchImpl: typeof fetch = fetch,
  base = '/remux',
): Promise<boolean | null> {
  try {
    const res = await fetchImpl(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (res.ok) {
      const token = res.headers.get('x-den-browser-token');
      if (token) browserTokens.set(browserBase(base), token);
      else browserTokens.delete(browserBase(base)); // an older server still sets its same-origin cookie
      return true;
    }
    forgetRefusedToken(base, res);
    return res.status === 401 ? false : null;
  } catch {
    return null;
  }
}

/**
 * What den-remux said of each install offered as den-subtitles' — taken, or refused — so a later session offers the
 * one it took first and never one it refused: each refusal is a request, and new sessions are rate-limited.
 */
const subtitleVerdicts = new Map<string, boolean>();

/** Forget those verdicts (tests). */
export function forgetSubtitles(): void {
  subtitleVerdicts.clear();
}

/**
 * The languages a session asks for, most wanted first, as ISO 639-1: Settings › Playback's audio language — or, left
 * on Original, the title's own — then this browser's; and the subtitle setting's language alone, or none where
 * subtitles are off.
 */
export function wantedLanguages(
  prefs: { audio?: string; subtitle?: string },
  original: string | undefined,
  browser: readonly string[],
): Pick<Want, 'audio' | 'subtitleLanguages'> {
  const base = (tag: string) => tag.split('-')[0]!.toLowerCase();
  const first = prefs.audio ?? original;
  return {
    audio: [...new Set([...(first ? [first] : []), ...browser].map(base).filter(Boolean))],
    subtitleLanguages: prefs.subtitle ? [base(prefs.subtitle)] : [],
  };
}

/** A session at den-remux on `base` (`findRemux`); its playlist comes back as a URL this page can play. */
export async function startSession(
  want: Want,
  fetchImpl: typeof fetch = fetch,
  base = '/remux',
): Promise<Session | Refused> {
  const { subtitles, subtitleLanguages, ...fields } = want;
  const offered = subtitles
    .filter((install) => subtitleVerdicts.get(install) !== false)
    .sort(
      (a, b) => Number(subtitleVerdicts.get(b) === true) - Number(subtitleVerdicts.get(a) === true),
    );
  const candidates: (string | undefined)[] = subtitleLanguages.length
    ? [...offered, undefined]
    : [undefined];
  for (const candidate of candidates) {
    const body = candidate ? { ...fields, subtitles: candidate, subtitleLanguages } : fields;
    let res: Response;
    try {
      res = await fetchImpl(`${base}/session`, {
        method: 'POST',
        headers: browserHeaders(base),
        body: JSON.stringify(body),
      });
    } catch {
      return { failure: 'unreachable' };
    }
    if (res.status === 201) {
      if (candidate) subtitleVerdicts.set(candidate, true);
      // den-remux answers with an absolute path on its own host; on another origin it needs that host in front.
      const session = (await res.json()) as Session;
      return /^https?:/.test(base)
        ? { ...session, playlist: new URL(session.playlist, base).href }
        : session;
    }
    forgetRefusedToken(base, res);
    const error = await errorCode(res);
    if (error === 'bad_subtitles' && candidate) {
      subtitleVerdicts.set(candidate, false); // not den-subtitles: the next, or none
      continue;
    }
    // A zero fallback here means "it named nothing", which is the caller's own interval rather than
    // a wait of no time at all.
    const named = retryAfterMs(res, 0) || undefined;
    return { failure: failureOf(res.status, error), retryMs: named };
  }
  return { failure: 'unreachable' };
}

/**
 * What is playing, as the player names it: the release, and — where den-remux couldn't send it as it is — what it
 * came down to, so a converted 4K remux doesn't pass for the 4K it says on the tin.
 */
export function describeRelease(session: Session): string {
  const { converted, release } = releaseParts(session);
  return converted ? `${release} · converted here to ${converted}` : release;
}

/**
 * The same, in its two parts: what den-remux brought the release down to — absent when it sent the release as it
 * is — and the release itself, so the player can lead with what plays and leave the rest quieter.
 */
export function releaseParts(session: Session): { converted?: string; release: string } {
  const video = session.video;
  const release = session.release.label;
  if (!video?.transcoded) return { release };
  const size = video.height ? `${video.height}p ` : '';
  return { converted: `${size}H.264${video.tonemapped ? ' SDR' : ''}`, release };
}

/**
 * What the session carries of a playing track with more channels than that — "Stereo" for surround converted to two
 * channels, "5.1" for a 7.1 track folded to 5.1 — so the player can say so rather than leave it to pass for a fault.
 * Null when the session carries the track's own layout, or den-remux doesn't say.
 */
export function downmixLabel(session: Session): string | null {
  const track = session.audioTracks[session.audioTrack];
  if (!track || session.audioChannels === undefined || session.audioChannels >= track.channels)
    return null;
  return session.audioChannels <= 2 ? 'Stereo' : '5.1';
}

/**
 * Whether to hand a playlist to the `<video>` element itself rather than to hls.js. Apple's WebKit — Safari, and every
 * browser on an iPhone — plays it natively, with AirPlay and picture-in-picture. Chrome answers `canPlayType` for HLS
 * too now (151 says "maybe"), but its own player fetched den-remux's master and media playlists and never asked for a
 * segment, so wherever Media Source Extensions exist outside WebKit, hls.js plays instead.
 */
export function nativeHls(
  element: Pick<HTMLMediaElement, 'canPlayType'>,
  env: { vendor?: string; mse?: boolean } = {
    vendor: globalThis.navigator?.vendor,
    mse: 'MediaSource' in globalThis || 'ManagedMediaSource' in globalThis,
  },
): boolean {
  if (!element.canPlayType('application/vnd.apple.mpegurl')) return false;
  return (env.vendor ?? '').startsWith('Apple') || !env.mse;
}

/** A release den-remux could play, as it lists them: never a URL. */
export interface Release {
  label: string;
  filename: string;
  size?: number | null;
}

/**
 * The releases den-remux could play for a title, in the order it would try them, so the player can pick one by
 * `filename`; null when it can't say.
 */
export async function listReleases(
  title: Pick<Want, 'imdb' | 'season' | 'episode' | 'scout'>,
  fetchImpl: typeof fetch = fetch,
  base = '/remux',
): Promise<Release[] | null> {
  try {
    const res = await fetchImpl(`${base}/releases`, {
      method: 'POST',
      headers: browserHeaders(base),
      body: JSON.stringify(title),
    });
    forgetRefusedToken(base, res);
    if (!res.ok) return null;
    const releases = ((await res.json()) as { releases?: unknown }).releases;
    return Array.isArray(releases)
      ? releases.filter(
          (r): r is Release => typeof r?.label === 'string' && typeof r?.filename === 'string',
        )
      : null;
  } catch {
    return null;
  }
}

/** End the session, so it stops counting against den-remux's cap — sent even as the page goes away. */
export function endSession(session: Session, fetchImpl: typeof fetch = fetch): void {
  void fetchImpl(session.playlist.replace(/\/master\.m3u8$/, ''), {
    method: 'DELETE',
    keepalive: true,
  }).catch(
    () => undefined, // it ends on its own once idle
  );
}

/**
 * Tell den-remux this browser couldn't play the session — its MediaError code (0 for hls.js) and message — for its
 * log: the browser's verdict is otherwise seen by nobody. A beacon, so it goes even as the page closes.
 */
export function reportFailure(
  session: Session,
  code: number,
  message: string,
  fetchImpl: typeof fetch = fetch,
): void {
  const url = session.playlist.replace(/\/master\.m3u8$/, '/report');
  const body = JSON.stringify({ code, message: message.slice(0, 200) });
  if (globalThis.navigator?.sendBeacon?.(url, body)) return;
  void fetchImpl(url, { method: 'POST', body, keepalive: true }).catch(() => undefined);
}

async function errorCode(res: Response): Promise<string | undefined> {
  try {
    const error = ((await res.json()) as { error?: unknown }).error;
    return typeof error === 'string' ? error : undefined;
  } catch {
    return undefined;
  }
}

function failureOf(status: number, error: string | undefined): Failure {
  if (status === 401) return 'login';
  if (status === 404) return 'none';
  if (status === 429) return 'busy';
  if (error === 'transcode_unavailable') return 'transcode';
  return 'unreachable';
}
