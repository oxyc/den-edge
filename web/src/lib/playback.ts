// Hearth-owned playback. Discovery exposes this module only after the configured combined Den addon's live route
// answers its capability probe. Otherwise the app keeps the existing Remux path. Hearth chooses direct HLS or Remux.

import { retryAfterMs } from './retryAfter';
import { relayFetch } from './relayFetch';
import type { Failure, Session, Want } from './remux';
import { directSubtitles } from './directSubtitles';

/** Longer than Edge's route-specific 130 s bound; the caller may still cancel an obsolete attempt immediately. */
export const PLAYBACK_ANSWER_MS = 150_000;

export type PlaybackWant = Omit<Want, 'scout' | 'subtitles' | 'ipv4Hint' | 'noHint'> & {
  /** An already-returned direct URL failed in the player; Hearth may skip direct delivery for this attempt. */
  directFailed?: boolean;
};

export type PlaybackErrorCode =
  | 'bad_request'
  | 'idempotency_conflict'
  | 'no_release'
  | 'playback_busy'
  | 'playback_timeout'
  | 'playback_unavailable'
  | 'replacement_pending'
  | 'source_unavailable'
  | 'unexpected_response';

/** Hearth's closed, non-secret reason why managed preparation fell back before the final operation failed. */
export type PlaybackCause =
  | 'managed_prepare_timeout'
  | 'torbox_authentication_failed'
  | 'torbox_item_not_found'
  | 'torbox_malformed_response'
  | 'torbox_managed_streaming_unavailable_for_plan'
  | 'torbox_playlist_unavailable'
  | 'torbox_rate_limited'
  | 'torbox_refused'
  | 'torbox_unavailable'
  | 'torbox_unreachable'
  | 'torbox_unsafe_stream_url';

/** Safe diagnostics for the page console. Arbitrary upstream bodies and provider identifiers never cross this type. */
interface PlaybackDiagnostics {
  retryMs?: number;
  code?: PlaybackErrorCode;
  cause?: PlaybackCause;
  httpStatus?: number;
  /** On `none`: the containers (`.ts`, `.avi`, …) of cached releases Remux left out because it can't open them. */
  formats?: string[];
}

export type PlaybackRefused =
  | ({ failure: Failure } & PlaybackDiagnostics)
  /** `legacy` is a rollout race: Edge concealed a route that answered discovery moments earlier. */
  | ({ failure: 'legacy' } & PlaybackDiagnostics);

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function href(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  try {
    return new URL(raw, globalThis.location?.href ?? 'https://den.invalid/').href;
  } catch {
    return undefined;
  }
}

function origin(value: unknown): string | undefined {
  const absolute = href(value);
  if (!absolute) return undefined;
  const url = new URL(absolute);
  return url.pathname === '/' && !url.search && !url.hash ? url.origin : undefined;
}

function releaseOf(value: unknown): Session['release'] | null {
  const release = record(value);
  const label = text(release?.label);
  const filename = text(release?.filename);
  if (!release || !label || !filename) return null;
  return {
    label,
    filename,
    size: number(release.size) ?? 0,
    ...((record(release.requested) as Session['release']['requested'] | null)
      ? { requested: release.requested as Session['release']['requested'] }
      : {}),
  };
}

function sessionOf(body: unknown, timing: string | null): Session | null {
  const answer = record(body);
  const playlist = href(answer?.url);
  const release = releaseOf(answer?.release);
  if (!answer || !playlist || !release) return null;
  const nested = record(answer.session);
  if (!nested) {
    return {
      external: true,
      playlist,
      duration: 0,
      release,
      audioTrack: 0,
      audioTracks: [],
      startupTiming: timing ?? undefined,
    };
  }

  // Hearth deliberately translates the existing Remux answer rather than inventing another session. Preserve its
  // additive fields, then normalize the handful whose facade names differ from the legacy JSON.
  const controls = {
    end: href(nested.endUrl),
    heartbeat: href(nested.heartbeatUrl),
    report: href(nested.reportUrl),
  };
  // Edge opens and describes the public listener on the facade's outer answer. Hearth keeps Remux's original
  // relative playlist inside `session`, which is what lets the cast page prefer the LAN base without accidentally
  // resolving the already-public outer URL back to itself.
  const publicBase = href(answer.publicBase) ?? href(nested.publicBase);
  const lanBase = href(answer.lanBase) ?? href(nested.lanBase);
  const relativePlaylist = text(nested.playlist);
  return {
    ...(nested as unknown as Session),
    sid: text(nested.id) ?? text(nested.sid),
    playlist,
    speed: href(nested.speedUrl) ?? href(nested.speed),
    publicBase,
    lanBase,
    lanPlaylist: lanBase && relativePlaylist ? new URL(relativePlaylist, lanBase).href : undefined,
    castOrigin: origin(answer.castOrigin) ?? origin(nested.castOrigin),
    hinted: answer.hinted === true || nested.hinted === true || undefined,
    release,
    duration: number(nested.duration) ?? 0,
    audioTrack: number(nested.audioTrack) ?? 0,
    audioTracks: Array.isArray(nested.audioTracks)
      ? (nested.audioTracks as Session['audioTracks'])
      : [],
    control:
      controls.end || controls.heartbeat || controls.report
        ? controls
        : (nested.control as Session['control'] | undefined),
    startupTiming: timing ?? undefined,
  };
}

async function errorBody(
  response: Response,
): Promise<{ error?: string; cause?: PlaybackCause; formats?: string[] }> {
  try {
    const body = record(await response.json());
    const formats: unknown = body?.formats;
    return {
      error: text(body?.error),
      cause: knownCause(text(body?.cause)),
      formats: Array.isArray(formats)
        ? formats
            .filter(
              (ext: unknown): ext is string =>
                typeof ext === 'string' && /^\.[a-z0-9]{1,5}$/i.test(ext),
            )
            .slice(0, 20)
        : undefined,
    };
  } catch {
    return {};
  }
}

function knownCause(cause: string | undefined): PlaybackCause | undefined {
  switch (cause) {
    case 'managed_prepare_timeout':
    case 'torbox_authentication_failed':
    case 'torbox_item_not_found':
    case 'torbox_malformed_response':
    case 'torbox_managed_streaming_unavailable_for_plan':
    case 'torbox_playlist_unavailable':
    case 'torbox_rate_limited':
    case 'torbox_refused':
    case 'torbox_unavailable':
    case 'torbox_unreachable':
    case 'torbox_unsafe_stream_url':
      return cause;
    default:
      return undefined;
  }
}

function knownCode(error: string | undefined): PlaybackErrorCode | undefined {
  switch (error) {
    case 'bad_request':
    case 'idempotency_conflict':
    case 'no_release':
    case 'playback_busy':
    case 'playback_timeout':
    case 'playback_unavailable':
    case 'replacement_pending':
    case 'source_unavailable':
      return error;
    default:
      return undefined;
  }
}

function failureOf(
  status: number,
  error: string | undefined,
  cause?: PlaybackCause,
): Failure | 'legacy' {
  // Hearth includes a closed, non-secret cause when its preferred source failed and its fallback then found
  // nothing usable. That is a source failure with an actionable explanation, not an ordinary empty result.
  if (status === 404 && error === 'no_release') return cause ? 'sourceUnavailable' : 'none';
  if (status === 404 && error !== 'no_release') return 'legacy';
  if (status === 409 && error === 'replacement_pending') return 'starting';
  if (status === 400 || status === 409) return 'request';
  if (status === 429) return 'busy';
  if (status === 401) return 'login';
  if (status === 410) return 'ended';
  if (status === 502) return 'sourceUnavailable';
  if (status === 503) return 'temporarilyUnavailable';
  if (status === 504) return 'timedOut';
  return 'unreachable';
}

function key(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolve one intentional playback attempt. A second request is made only after an ambiguous transport outcome or
 * cut-off 200 response, and reuses the same key/body so Hearth cannot create a second Remux session.
 */
export async function startPlayback(
  url: string,
  want: PlaybackWant,
  fetchImpl: typeof fetch = relayFetch,
  signal?: AbortSignal,
): Promise<Session | PlaybackRefused> {
  const idempotencyKey = key();
  const body = JSON.stringify(want);
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try {
      const deadline = AbortSignal.timeout(PLAYBACK_ANSWER_MS);
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body,
        cache: 'no-store',
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
    } catch {
      if (signal?.aborted || attempt > 0) return { failure: 'unreachable' };
      console.warn(
        'Managed playback got no complete HTTP answer; retrying the same operation idempotently.',
      );
      continue;
    }
    if (response.ok) {
      const session = await response
        .json()
        .then((json) => sessionOf(json, response.headers.get('server-timing')))
        .catch(() => null);
      if (session) {
        if (session.external) {
          const external = await directSubtitles(url, want, session.release, fetchImpl, signal);
          if (external) {
            session.subtitles = external.subtitles;
            session.externalSubtitles = external.tracks;
            session.loadExternalSubtitle = external.load;
            session.subtitleSource = 'den_subtitles';
            session.dispose = external.dispose;
          }
        }
        return session;
      }
      if (attempt === 0 && !signal?.aborted) {
        console.warn(
          'Managed playback returned an incomplete success response; replaying the same operation idempotently.',
        );
        continue;
      }
      return {
        failure: 'protocol',
        code: 'unexpected_response',
        httpStatus: response.status,
      };
    }
    const { error, cause, formats } = await errorBody(response);
    const failure = failureOf(response.status, error, cause);
    const retryMs =
      response.status === 429 ||
      response.status === 503 ||
      response.status === 504 ||
      cause === 'torbox_rate_limited'
        ? retryAfterMs(response, 0) || undefined
        : undefined;
    return {
      failure,
      code: knownCode(error) ?? 'unexpected_response',
      ...(cause ? { cause } : {}),
      ...(failure === 'none' && formats?.length ? { formats } : {}),
      httpStatus: response.status,
      ...(retryMs ? { retryMs } : {}),
    };
  }
  return { failure: 'unreachable' };
}
