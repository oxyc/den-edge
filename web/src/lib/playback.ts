// Hearth-owned playback. Discovery exposes this module only after the configured combined Den addon's live route
// answers its capability probe. Otherwise the app keeps the existing Remux path. Hearth chooses direct HLS or Remux.

import { retryAfterMs } from './retryAfter';
import { relayFetch } from './relayFetch';
import type { Failure, Refused, Session, Want } from './remux';
import { directSubtitles } from './directSubtitles';

/** Longer than Edge's route-specific 130 s bound; the caller may still cancel an obsolete attempt immediately. */
export const PLAYBACK_ANSWER_MS = 150_000;

export type PlaybackWant = Omit<Want, 'scout' | 'subtitles' | 'ipv4Hint' | 'noHint'> & {
  /** An already-returned direct URL failed in the player; Hearth may skip direct delivery for this attempt. */
  directFailed?: boolean;
};

/** `legacy` is a rollout-race answer: Edge concealed a route that answered discovery moments earlier. */
export type PlaybackRefused = Refused | { failure: 'legacy' };

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
  return {
    ...(nested as unknown as Session),
    sid: text(nested.id) ?? text(nested.sid),
    playlist,
    speed: href(nested.speedUrl) ?? href(nested.speed),
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

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    return text(((await response.json()) as { error?: unknown }).error);
  } catch {
    return undefined;
  }
}

function failureOf(status: number, error: string | undefined): Failure | 'legacy' {
  if (status === 404 && error === 'no_release') return 'none';
  if (status === 404 && error !== 'no_release') return 'legacy';
  if (status === 409 && error === 'replacement_pending') return 'starting';
  if (status === 429) return 'busy';
  if (status === 401) return 'login';
  if (status === 410) return 'ended';
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
      if (attempt === 0 && !signal?.aborted) continue;
      return { failure: 'unreachable' };
    }
    const failure = failureOf(response.status, await errorCode(response));
    return {
      failure,
      ...(response.status === 429 || response.status === 503
        ? { retryMs: retryAfterMs(response, 0) || undefined }
        : {}),
    } as PlaybackRefused;
  }
  return { failure: 'unreachable' };
}
