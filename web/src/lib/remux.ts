// Playback in this browser through den-remux (oxyc/den-remux, issue #11): it copies the video, makes the audio AAC
// and serves HLS. This page names the title and the library's scout install; den-remux picks a cached release it can
// play, and keeps scout's tickets and the debrid's links to itself. Its routes are on this origin under /remux
// (tailscale serve), and a cookie from a one-time browser key lets this browser start sessions.

import type { Entry } from './routes';

export interface Session {
  /** `/remux/s/<sid>/<sig>/master.m3u8`: a signed URL, so AirPlay can play it too. */
  playlist: string;
  /** Seconds. */
  duration: number;
  release: { label: string; filename: string; size: number };
  video?: { codec: string; transcoded: boolean };
  /** The audio track playing, by index into `audioTracks`: one per session, re-encoded to AAC. */
  audioTrack: number;
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
  /** What this browser decodes: `h264`, and `hevc` when it can. */
  videoCodecs: string[];
  /** Another track of an earlier session's release: its index there, and that release's filename. */
  audioTrack?: number;
  filename?: string;
}

export type Failure = 'login' | 'none' | 'busy' | 'transcode' | 'unreachable';

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
    try {
      const res = await fetchImpl(`${entry.url}/health`);
      if (res.ok && typeof ((await res.json()) as { status?: unknown }).status === 'string') return entry.url;
    } catch {
      // Out of reach from here, or not den-remux: the next.
    }
  }
  return null;
}

/** Let this browser in with its key: true, false for a key den-remux doesn't know, null when it can't be reached. */
export async function login(key: string, fetchImpl: typeof fetch = fetch, base = '/remux'): Promise<boolean | null> {
  try {
    const res = await fetchImpl(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (res.ok) return true;
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

/** A session at den-remux on `base` (`findRemux`); its playlist comes back as a URL this page can play. */
export async function startSession(
  want: Want,
  fetchImpl: typeof fetch = fetch,
  base = '/remux',
): Promise<Session | { failure: Failure }> {
  const { subtitles, subtitleLanguages, ...fields } = want;
  const offered = subtitles
    .filter((install) => subtitleVerdicts.get(install) !== false)
    .sort((a, b) => Number(subtitleVerdicts.get(b) === true) - Number(subtitleVerdicts.get(a) === true));
  const candidates: (string | undefined)[] = subtitleLanguages.length ? [...offered, undefined] : [undefined];
  for (const candidate of candidates) {
    const body = candidate ? { ...fields, subtitles: candidate, subtitleLanguages } : fields;
    let res: Response;
    try {
      res = await fetchImpl(`${base}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      return { failure: 'unreachable' };
    }
    if (res.status === 201) {
      if (candidate) subtitleVerdicts.set(candidate, true);
      // den-remux answers with an absolute path on its own host; on another origin it needs that host in front.
      const session = (await res.json()) as Session;
      return /^https?:/.test(base) ? { ...session, playlist: new URL(session.playlist, base).href } : session;
    }
    const error = await errorCode(res);
    if (error === 'bad_subtitles' && candidate) {
      subtitleVerdicts.set(candidate, false); // not den-subtitles: the next, or none
      continue;
    }
    return { failure: failureOf(res.status, error) };
  }
  return { failure: 'unreachable' };
}

/** End the session, so it stops counting against den-remux's cap — sent even as the page goes away. */
export function endSession(session: Session, fetchImpl: typeof fetch = fetch): void {
  void fetchImpl(session.playlist.replace(/\/master\.m3u8$/, ''), { method: 'DELETE', keepalive: true }).catch(
    () => undefined, // it ends on its own once idle
  );
}

/**
 * Tell den-remux this browser couldn't play the session — its MediaError code (0 for hls.js) and message — for its
 * log: the browser's verdict is otherwise seen by nobody. A beacon, so it goes even as the page closes.
 */
export function reportFailure(session: Session, code: number, message: string, fetchImpl: typeof fetch = fetch): void {
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
