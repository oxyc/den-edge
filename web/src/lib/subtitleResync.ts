import type { Session } from './remux';
import { relayFetch } from './relayFetch';
import { apiUrl, serviceOrigin } from './runtimeUrl';

type Subtitle = NonNullable<Session['subtitles']>[number];
const DEADLINE_MS = 130_000;
const VTT_LIMIT = 4 * 1024 * 1024;
const CONTROL = /^\/remux\/s\/[A-Za-z0-9_-]{22}\/[A-Za-z0-9_-]{22}\/subtitle-resync$/;

/** Resolve only this Den's control capability. Never send membership to the public media/source origin. */
function controlUrl(session: Session): URL {
  const capability = session.subtitleResync;
  if (!capability?.supported) throw new Error('unavailable');
  const base =
    __DEN_TV_SERVICE_ORIGIN__ || __DEN_TV_API_ORIGIN__
      ? serviceOrigin()
      : globalThis.location?.origin;
  const url = new URL(__DEN_TV_API_ORIGIN__ ? apiUrl(capability.url) : capability.url, base);
  const playlist = new URL(session.playlist, base);
  if (
    url.origin !== base ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !CONTROL.test(url.pathname) ||
    url.pathname.replace(/subtitle-resync$/, 'master.m3u8') !== playlist.pathname
  )
    throw new Error('unavailable');
  return url;
}

async function boundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('unavailable');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    if (Number(response.headers.get('content-length')) > limit) throw new Error('unavailable');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('unavailable');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

async function request(
  session: Session,
  track: Subtitle,
  signal: AbortSignal,
  checkOnly: boolean,
  fetchImpl: typeof fetch,
): Promise<{ body: Record<string, unknown>; url: URL; signal: AbortSignal }> {
  if (!Number.isSafeInteger(track.rendition) || track.rendition! < 0 || !track.resyncSupported)
    throw new Error('unavailable');
  const url = controlUrl(session);
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(DEADLINE_MS)]);
  const response = await fetchImpl(url.href, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      rendition: track.rendition,
      audioTrack: session.audioTrack,
      ...(checkOnly ? { checkOnly: true } : {}),
    }),
    signal: bounded,
    cache: 'no-store',
    redirect: 'error',
  });
  if (!response.ok || response.headers.has('x-den-degraded')) throw new Error('unavailable');
  const body = JSON.parse(await boundedText(response, 4096)) as Record<string, unknown>;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('unavailable');
  return { body, url, signal: bounded };
}

/** The rendition chooses its actual candidate lazily; a hash-exact result never offers alignment. */
export async function checkSubtitleResync(
  session: Session,
  track: Subtitle,
  signal: AbortSignal,
  fetchImpl: typeof fetch = relayFetch,
): Promise<boolean> {
  const { body } = await request(session, track, signal, true, fetchImpl);
  return body.supported === true && body.source === 'opensubtitles' && body.hashMatch === false;
}

/** Fetch and validate the complete aligned document before the player replaces any current cues. */
export async function resyncSubtitle(
  session: Session,
  track: Subtitle,
  signal: AbortSignal,
  fetchImpl: typeof fetch = relayFetch,
): Promise<{ blob: Blob; offset: number }> {
  const result = await request(session, track, signal, false, fetchImpl);
  const { body } = result;
  if (
    typeof body.url !== 'string' ||
    typeof body.offsetMs !== 'number' ||
    !Number.isFinite(body.offsetMs)
  )
    throw new Error('unavailable');
  const url = new URL(body.url, result.url);
  const expected = result.url.pathname.replace(
    /subtitle-resync$/,
    `sub${track.rendition}.aligned.vtt`,
  );
  if (
    url.origin !== result.url.origin ||
    url.pathname !== expected ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error('unavailable');
  const response = await fetchImpl(url.href, {
    signal: result.signal,
    cache: 'no-store',
    redirect: 'error',
    headers: { accept: 'text/vtt' },
  });
  if (!response.ok || response.headers.has('x-den-degraded')) throw new Error('unavailable');
  const vtt = await boundedText(response, VTT_LIMIT);
  if (!/^\uFEFF?WEBVTT(?:\s|$)/.test(vtt) || !/\d{2}:\d{2}\.\d{3}\s+-->\s+/.test(vtt))
    throw new Error('unavailable');
  signal.throwIfAborted();
  return { blob: new Blob([vtt], { type: 'text/vtt' }), offset: body.offsetMs / 1000 };
}
