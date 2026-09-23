// Playback in this browser through den-remux (oxyc/den-remux, issue #11): it copies the video, makes the audio AAC
// and serves HLS. This page names the title and the library's scout install; den-remux picks a cached release it can
// play, and keeps scout's tickets and the debrid's links to itself. Its routes are on this origin under /remux
// (tailscale serve), and a cookie from a one-time browser key lets this browser start sessions.

import { sharedInstallOf } from './grants';
import { ipv4Hint } from './ipv4';
import { linkRate, SPEED_PROBE_BYTES } from './linkRate';
import type { Playable } from './playable';
import { retryAfterMs } from './retryAfter';
import type { Entry } from './routes';
import { relayFetch } from './relayFetch';

export interface Session {
  /** den-remux's id for the session, which a replacement names (`Want.replaces`). */
  sid?: string;
  /** `/remux/s/<sid>/<sig>/master.m3u8`: a signed URL, so AirPlay can play it too. */
  playlist: string;
  /** Session-bound bandwidth probe under the same signature as the playlist. */
  speed?: string;
  /** The public origin (an address or a name), present only on a member-gated relayed session. */
  publicBase?: string;
  /** The same den-remux on the home network over https: reachable from home Wi-Fi, where the router does not loop
   * a request for the public address back in. The sender tries it first and falls back to the public one. */
  lanBase?: string;
  /** This session's playlist on `lanBase`, made absolute the same way as `playlist` is on the public origin. */
  lanPlaylist?: string;
  /** Static keyless iframe origin that owns browser-away and Cast media requests. */
  castOrigin?: string;
  /** Set when den-edge opened the media listener for the `ipv4Hint` this page sent rather than the address it saw. */
  hinted?: boolean;
  /** Seconds. */
  duration: number;
  release: {
    label: string;
    filename: string;
    size: number;
    /** Set when den-remux opened this release instead of the one asked for, with why it couldn't play that one. */
    requested?: { filename: string; why?: string };
  };
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
  /**
   * The subtitle renditions in the playlist, in the order den-remux wrote them.
   *
   * den-remux has always sent these and this interface never declared them, so the app threw them away and
   * the player had no picker. One document per language: den-remux exposes the best match it found, which is
   * why `maxSubtitlesPerLanguage` cannot be honoured here however it is set.
   */
  subtitles?: { language: string; name: string }[];
  /** Bits a second a copy needs to start within 10 s and never run dry; null for a transcode or an unknown one. */
  need?: number | null;
  /** Seconds to buffer before playing, on the link this browser named, so it then plays through; null or absent: none. */
  prebuffer?: number | null;
  /** Each segment's `[start, bytes]` of a copy: the demand the player weighs its live rate against (`switchPolicy`). */
  segments?: [number, number][] | null;
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
  player?: 'native' | 'hls.js' | 'cast';
  /**
   * This browser's IPv4 address (`ipv4.ts`), for den-edge alone: added by `startSession` only when den-edge sees the
   * page over IPv6 and asks for it (`ipv4_hint_wanted`).
   */
  ipv4Hint?: string;
  /** Asked again after a hinted session never played, or when no address was found: den-edge uses no hint for it. */
  noHint?: boolean;
  /** Releases not to open: the ones this player switched away from. */
  exclude?: string[];
  /**
   * `never`: no transcode for this request — every one made once playback has started, which a conversion never
   * replaces. Absent, den-remux's selection decides, a transcode included, before the first frame.
   */
  transcode?: 'never';
  /** Only a copy that fits `maxBitrate`, or nothing (`noFit`): a switch away from a release the link can't carry. */
  fitsOnly?: boolean;
  /**
   * The session this one replaces mid-film: den-remux keeps it playing, one past this browser's share, until this one
   * serves media, instead of ending it as soon as this is asked for.
   */
  replaces?: string;
}

export type Failure =
  | 'login'
  | 'none'
  | 'busy'
  | 'transcode'
  | 'unreachable'
  | 'ended'
  | 'public'
  | 'ipv6'
  | 'cast'
  /** Nothing plays here as it is, and no transcode can be had now (the GPU in use, or `transcode: 'never'`). */
  | 'noCopy'
  /** No other release fits the link as it is (`fitsOnly`). */
  | 'noFit';

/**
 * An invited guest's play away from home meets two known limits, not faults: the media address is IPv4-only, and a
 * Cast receiver would need the listener opened wider than a guest is ever given.
 */
export const guestLimits: Record<'ipv6' | 'cast', string> = {
  ipv6: 'Playing away from home needs an IPv4 connection for now. Try another network (a phone hotspot often works).',
  cast: 'Casting isn’t available for invited guests yet — play it in this browser instead.',
};

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
  fetchImpl: typeof fetch = relayFetch,
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
  // The public web name exposes only member-gated control JSON at this same-origin mount. Its session answer
  // supplies the IP-literal media origin; no video byte follows this relay.
  try {
    const res = await fetchImpl('/remux/health');
    if (res.ok && typeof ((await res.json()) as { status?: unknown }).status === 'string')
      return '/remux';
  } catch {
    // No control relay here either.
  }
  return null;
}

/**
 * Whether this browser refuses the page the home network, which is a different thing from no route reaching
 * den-remux — and the two were told apart only by a sentence that assumed the second.
 *
 * Chrome's Local Network Access (enforcing since 142) classifies a tailnet address (100.64.0.0/10) as local, so a page
 * on the public name can be refused before a request leaves. Refusal only: `prompt` means the question has not been
 * put, and a browser that does not know the name has no such policy — neither is something to tell a viewer about.
 */
export async function localNetworkRefused(): Promise<boolean> {
  const permissions = globalThis.navigator?.permissions;
  if (!permissions) return false;
  try {
    const status = await permissions.query({ name: 'local-network-access' as PermissionName });
    return status.state === 'denied';
  } catch {
    // An unknown permission name throws; that browser does not enforce this either.
    return false;
  }
}

export { linkRate, SPEED_PROBE_BYTES };
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
  premeasured.clear();
}

/**
 * How long this browser remembers a route's link: a later play asks for a session that fits it on its first request,
 * rather than starting one, measuring, and starting another.
 */
export const LINK_MEMORY_MS = 6 * 60 * 60_000;
const LINK_KEY = 'den.remux.link:';

/** A route's link as remembered: when, and the `maxBitrate` it allows — none where den-remux was on the home network. */
export interface RememberedLink {
  at: number;
  maxBitrate?: number;
}

/** This page's storage, or undefined where the browser refuses it (a blocked or private window). */
function linkStorage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch (error) {
    console.warn('No local storage: the link is measured on every play.', error);
    return undefined;
  }
}

/** The link remembered for den-remux at `base`, when it is younger than LINK_MEMORY_MS. */
export function rememberedLink(
  base: string,
  now = Date.now(),
  storage = linkStorage(),
): RememberedLink | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(LINK_KEY + browserBase(base));
    if (!raw) return undefined;
    const kept = JSON.parse(raw) as Partial<RememberedLink> | null;
    if (typeof kept?.at !== 'number' || now - kept.at >= LINK_MEMORY_MS) return undefined;
    return typeof kept.maxBitrate === 'number' && kept.maxBitrate > 0
      ? { at: kept.at, maxBitrate: kept.maxBitrate }
      : { at: kept.at };
  } catch (error) {
    console.warn('The remembered link could not be read.', error);
    return undefined;
  }
}

/** Remember den-remux at `base` allows `maxBitrate` from here; undefined: it answered on the home network. */
export function rememberLink(
  base: string,
  maxBitrate: number | undefined,
  now = Date.now(),
  storage = linkStorage(),
): void {
  try {
    storage?.setItem(
      LINK_KEY + browserBase(base),
      JSON.stringify(maxBitrate === undefined ? { at: now } : { at: now, maxBitrate }),
    );
  } catch (error) {
    console.warn('The measured link could not be remembered.', error);
  }
}

/**
 * The `maxBitrate` a session through the public relay asks with: the one this player already measured, else the one
 * this browser remembers. Undefined only with neither — and only then is the session's link measured inside it and the
 * session perhaps replaced (`restartAfterMeasure`).
 */
export function relayLimit(
  route: string,
  measured: number | undefined,
  storage = linkStorage(),
): number | undefined {
  return measured ?? rememberedLink(route, Date.now(), storage)?.maxBitrate;
}

/** Routes whose link this page has set out to time ahead of a play (`premeasureLink`). */
const premeasured = new Set<string>();

function whenIdle(run: () => void): () => void {
  if (typeof globalThis.requestIdleCallback === 'function') {
    const id = requestIdleCallback(run, { timeout: 5_000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(run, 1_000);
  return () => clearTimeout(id);
}

/**
 * Time the link to den-remux at `base` once the page is idle and remember it (`rememberLink`), so the first play asks
 * for a session that fits. Nothing at home, nothing where a link is remembered, and once per route per page. The
 * returned function gives up on it — Play does, which then measures inside its session as it always could.
 */
export function premeasureLink(
  base: string,
  {
    fetchImpl = relayFetch,
    now = () => performance.now(),
    storage = linkStorage(),
    idle = whenIdle,
  }: {
    fetchImpl?: typeof fetch;
    now?: () => number;
    storage?: Storage;
    idle?: (run: () => void) => () => void;
  } = {},
): () => void {
  const key = base && browserBase(base);
  if (!key || onLan(base) || premeasured.has(key) || rememberedLink(base, Date.now(), storage))
    return () => undefined;
  premeasured.add(key);
  const controller = new AbortController();
  let done = false;
  const cancelIdle = idle(() => {
    void timeTransferUrl(
      `${base}/speed?bytes=${SPEED_PROBE_BYTES}`,
      fetchImpl,
      now,
      controller.signal,
    ).then((rate) => {
      done = true;
      if (controller.signal.aborted) return;
      if (rate) rememberLink(base, Math.round(rate * LINK_HEADROOM), Date.now(), storage);
      else console.warn(`The link to ${base} could not be timed ahead of play.`);
    });
  });
  return () => {
    if (done) return;
    cancelIdle();
    controller.abort();
    premeasured.delete(key);
  };
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
 * The bits a second den-remux at `base` gets to this browser: its `/speed` timed by `linkRate`, until the end or
 * SPEED_READ_MS. Asked once per LINK_TTL_MS, sessions in between sharing the answer; null when it couldn't be timed.
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
  return timeTransferUrl(`${base}/speed?bytes=${SPEED_PROBE_BYTES}`, fetchImpl, now);
}

/** The rate `url` delivers at; null when it couldn't be timed, or `signal` gave up on it. */
async function timeTransferUrl(
  url: string,
  fetchImpl: typeof fetch,
  now: () => number,
  signal?: AbortSignal,
): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SPEED_DEADLINE_MS);
  const giveUp = () => controller.abort();
  signal?.addEventListener('abort', giveUp, { once: true });
  const chunks: [number, number][] = [];
  try {
    const separator = url.includes('?') ? '&' : '?';
    const speedUrl = url.includes('bytes=') ? url : `${url}${separator}bytes=${SPEED_PROBE_BYTES}`;
    const res = await fetchImpl(speedUrl, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const at = now();
      chunks.push([at, value.byteLength]);
      if (at - chunks[0]![0] >= SPEED_READ_MS) {
        void reader.cancel();
        break;
      }
    }
  } catch {
    // Given up on, or cut off: what arrived before still says something.
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', giveUp);
  }
  if (signal?.aborted) return null;
  return linkRate(chunks);
}

/**
 * The `maxBitrate` a session at `base` asks for: LINK_HEADROOM of the measured link, away from home; undefined at home,
 * and wherever the link couldn't be measured — den-remux then picks as it always has. A link remembered in this browser
 * (`rememberedLink`) is taken as it is.
 */
export async function linkLimit(
  base: string,
  fetchImpl: typeof fetch = fetch,
  now?: () => number,
  storage = linkStorage(),
): Promise<number | undefined> {
  if (onLan(base)) return undefined;
  const kept = rememberedLink(base, Date.now(), storage);
  if (kept) return kept.maxBitrate;
  const rate = await measureLink(base, fetchImpl, now);
  const limit = rate ? Math.round(rate * LINK_HEADROOM) : undefined;
  if (limit !== undefined) rememberLink(base, limit, Date.now(), storage);
  return limit;
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
/** den-remux builds at most this many subtitle renditions for a session (its own `MAX_SUBTITLE_LANGS`). */
const MAX_SUBTITLE_LANGUAGES = 4;

export function wantedLanguages(
  prefs: { audio?: string; subtitle?: string; shownSubtitles?: readonly string[] },
  original: string | undefined,
  browser: readonly string[],
): Pick<Want, 'audio' | 'subtitleLanguages'> {
  const base = (tag: string) => tag.split('-')[0]!.toLowerCase();
  const first = prefs.audio ?? original;
  // The preferred language leads, because den-remux marks the FIRST rendition DEFAULT=YES — so the one the
  // viewer chose in Settings is the one that comes up without asking.
  //
  // Asking for more than one is what gives the player a picker at all: a single rendition marked default is
  // subtitles forced on with nothing to switch to and no Off. And languages are asked for even when the
  // subtitle setting is unset, or "no preferred language" would keep meaning "no subtitles offered", which is
  // not the same thing and is not what the setting says.
  const wanted = [
    ...(prefs.subtitle ? [prefs.subtitle] : []),
    ...(prefs.shownSubtitles ?? []),
    ...browser,
  ];
  return {
    audio: [...new Set([...(first ? [first] : []), ...browser].map(base).filter(Boolean))],
    subtitleLanguages: [...new Set(wanted.map(base).filter(Boolean))].slice(
      0,
      MAX_SUBTITLE_LANGUAGES,
    ),
  };
}

/**
 * A session at den-remux on `base` (`findRemux`); its playlist comes back as a URL this page can play. `lookup` finds
 * this browser's IPv4 address when den-edge asks for it.
 */
export async function startSession(
  want: Want,
  fetchImpl: typeof fetch = relayFetch,
  base = '/remux',
  lookup: () => Promise<string | undefined> = () => ipv4Hint(),
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
      const mediaBase = session.publicBase ?? (/^https?:/.test(base) ? base : undefined);
      return mediaBase
        ? {
            ...session,
            playlist: new URL(session.playlist, mediaBase).href,
            speed: session.speed ? new URL(session.speed, mediaBase).href : undefined,
            lanPlaylist: session.lanBase
              ? new URL(session.playlist, session.lanBase).href
              : undefined,
          }
        : session;
    }
    forgetRefusedToken(base, res);
    const error = await errorCode(res);
    if (error === 'bad_subtitles' && candidate) {
      subtitleVerdicts.set(candidate, false); // not den-subtitles: the next, or none
      continue;
    }
    // den-edge sees this page over IPv6 and asks for its IPv4 address. Looked up only now, so a page it sees over
    // IPv4 never makes that third-party request; asked again once, as a page with no address when none was found.
    if (error === 'ipv4_hint_wanted' && !want.ipv4Hint && !want.noHint) {
      const address = await lookup();
      const again: Want = address ? { ...want, ipv4Hint: address } : { ...want, noHint: true };
      return startSession(again, fetchImpl, base, lookup);
    }
    // Past den-edge's cap on distinct reported addresses: asked once more as a page that reported none.
    if (error === 'hint_limit' && want.ipv4Hint) {
      return startSession({ ...want, ipv4Hint: undefined, noHint: true }, fetchImpl, base, lookup);
    }
    // A zero fallback here means "it named nothing", which is the caller's own interval rather than
    // a wait of no time at all.
    const named = retryAfterMs(res, 0) || undefined;
    return {
      failure: failureOf(res.status, error, !!sharedInstallOf(want.scout)),
      retryMs: named,
    };
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

/** Whether this browser plays a release: as it is, after a conversion, or not at all. */
export type Plays = 'yes' | 'convert' | 'no';

/** A release den-remux could play, as it lists them: never a URL. */
export interface Release {
  label: string;
  filename: string;
  size?: number | null;
  /** den-remux's verdict for the claims it was sent; `yes` from a den-remux that gives none. */
  plays: Plays;
  /** A short reason for a `convert` or `no`, when den-remux gives one. */
  why?: string;
}

/** What a browser decodes, as the session request states it: den-remux judges each release against it. */
export type Claims = Pick<Want, 'videoCodecs' | 'playable'>;

/** The `videoCodecs` a browser's `playable` claims stand for: `h264`, and `hevc` when it decodes it. */
export function videoCodecsOf(can: Playable): string[] {
  return can.hevcMain || can.hevcMain10 ? ['h264', 'hevc'] : ['h264'];
}

/**
 * The releases den-remux could play for a title, in the order it would try them, so the player can pick one by
 * `filename`; null when it can't say. Given the browser's `claims` it also says which of them play here (`plays`).
 */
export async function listReleases(
  title: Pick<Want, 'imdb' | 'season' | 'episode' | 'scout'>,
  fetchImpl: typeof fetch = relayFetch,
  base = '/remux',
  claims?: Claims,
): Promise<Release[] | null> {
  try {
    const res = await fetchImpl(`${base}/releases`, {
      method: 'POST',
      headers: browserHeaders(base),
      body: JSON.stringify(claims ? { ...title, ...claims } : title),
    });
    forgetRefusedToken(base, res);
    if (!res.ok) return null;
    const releases = ((await res.json()) as { releases?: unknown }).releases;
    if (!Array.isArray(releases)) return null;
    return releases
      .filter(
        (r): r is Record<string, unknown> & { label: string; filename: string } =>
          typeof r?.label === 'string' && typeof r?.filename === 'string',
      )
      .map(({ plays, why, ...release }) => ({
        ...(release as Omit<Release, 'plays' | 'why'>),
        plays: plays === 'no' || plays === 'convert' ? plays : 'yes',
        ...(typeof why === 'string' && why ? { why } : {}),
      }));
  } catch {
    return null;
  }
}

/**
 * Whether the cast page plays this session, and so owns its report and its end. It is on the public media address,
 * which this page's `connect-src` does not name: a report or a DELETE from here is refused before it leaves the
 * browser. The cast page may connect there, and sends both itself (web/cast/src/main.ts).
 */
export function playedInCastPage(session: Session): boolean {
  return Boolean(session.castOrigin && session.publicBase);
}

/**
 * End the session, so it stops counting against den-remux's cap — sent even as the page goes away. Not one the cast
 * page plays: that page ends it as its frame is removed.
 */
export function endSession(session: Session, fetchImpl: typeof fetch = fetch): void {
  if (playedInCastPage(session)) return;
  void fetchImpl(session.playlist.replace(/\/master\.m3u8$/, ''), {
    method: 'DELETE',
    keepalive: true,
  }).catch(
    () => undefined, // it ends on its own once idle
  );
}

/**
 * Tell den-remux this browser couldn't play the session — its MediaError code (0 for hls.js) and message — for its
 * log: the browser's verdict is otherwise seen by nobody. A beacon, so it goes even as the page closes. Not for a
 * session the cast page plays, which reports its own failures and its stats.
 */
export function reportFailure(
  session: Session,
  code: number,
  message: string,
  fetchImpl: typeof fetch = fetch,
): void {
  if (playedInCastPage(session)) return;
  const url = session.playlist.replace(/\/master\.m3u8$/, '/report');
  const body = JSON.stringify({ code, message: message.slice(0, 200) });
  if (globalThis.navigator?.sendBeacon?.(url, body)) return;
  void fetchImpl(url, { method: 'POST', body, keepalive: true }).catch(() => undefined);
}

/**
 * Whether this session's bytes have stopped arriving, rather than the player having refused them.
 *
 * `MediaError 3` is reported for both. On Apple's native player the page never sees the segment responses at
 * all, so a dead release and an undecodable one are indistinguishable from here — and the retry that asks for
 * less (`withoutRefused`) is then spent converting a picture that cannot be fetched, on a box that converts
 * one session at a time. Measured 2026-09-16: four refusals read as a codec fault were every one of them a
 * source that had stopped answering (oxyc/den#43).
 *
 * den-remux answers `502 source_failed` for a segment once its job has failed `MAX_FAILURES` times. Ask for
 * the segment the player is stalled on, which is why `at` is required: asking for the first one instead
 * starts a fresh job at the beginning of the film, and that answers about a part of the stream nobody is
 * watching — with a 200.
 *
 * False for anything unclear, a network this browser cannot reach included. Not knowing must never read as a
 * dead release, because the cost of that mistake is refusing a title that would have played.
 */
export async function sourceFailed(
  session: Session,
  at: number,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const master = new URL(session.playlist, globalThis.location?.href ?? 'https://den.invalid/');
    const variant = (await (await fetchImpl(master.href)).text())
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#'));
    if (!variant) return false;
    const media = new URL(variant, master);
    const lines = (await (await fetchImpl(media.href)).text())
      .split('\n')
      .map((line) => line.trim());
    let start = 0;
    let stalled: string | undefined;
    for (const [index, line] of lines.entries()) {
      if (!line.startsWith('#EXTINF:')) continue;
      const uri = lines[index + 1];
      const span = Number.parseFloat(line.slice('#EXTINF:'.length)) || 0;
      if (uri && !uri.startsWith('#') && at < start + span) {
        stalled = uri;
        break;
      }
      start += span;
    }
    if (!stalled) return false;
    const answer = await fetchImpl(new URL(stalled, media).href, { cache: 'no-store' });
    // The body is never read: a segment is tens of megabytes and the status is the whole answer.
    void answer.body?.cancel();
    return answer.status === 502;
  } catch {
    return false;
  }
}

async function errorCode(res: Response): Promise<string | undefined> {
  try {
    const error = ((await res.json()) as { error?: unknown }).error;
    return typeof error === 'string' ? error : undefined;
  } catch {
    return undefined;
  }
}

function failureOf(status: number, error: string | undefined, shared: boolean): Failure {
  if (status === 401) return 'login';
  // A shared library's access ran out (`grant_expired`): not a fault of the player.
  if (status === 410 && error === 'grant_expired') return 'ended';
  if (status === 404 && error === 'no_copy') return 'noCopy';
  if (status === 404 && error === 'no_fitting_copy') return 'noFit';
  // A revoked or unknown grant is a plain 404 from its `~<gid>` base, which reads like a title with no release —
  // den-remux's own answer for that names itself.
  if (status === 404) return shared && error !== 'no_playable_release' ? 'ended' : 'none';
  if (status === 429) return 'busy';
  if (error === 'transcode_unavailable') return 'transcode';
  // The session has no public address to hand this network.
  if (status === 503 && error === 'public_media_unavailable') return 'public';
  if (status === 503 && error === 'public_media_ipv6') return 'ipv6';
  if (status === 503 && error === 'public_media_cast') return 'cast';
  return 'unreachable';
}
