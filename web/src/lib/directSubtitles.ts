// External subtitles for a managed HLS URL. Hearth deliberately leaves TorBox's media playlist untouched, so the
// browser asks the same configured combined Den addon for its ordinary candidates and lazily owns chosen blob URLs.

import type { Session } from './remux';

const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;
// A candidate list is a small JSON document. Keep its browser-side allocation bounded independently of Edge's
// relay cap, both for direct/private deployments and so a changed relay limit cannot silently make this larger.
const MAX_LIST_BYTES = 256 * 1024;
const SUBTITLE_DEADLINE_MS = 10_000;

interface Candidate {
  url?: unknown;
  lang?: unknown;
  release?: unknown;
  hd?: unknown;
  fps?: unknown;
  hashMatch?: unknown;
  trusted?: unknown;
  downloads?: unknown;
  machineTranslated?: unknown;
  aiTranslated?: unknown;
  foreignPartsOnly?: unknown;
  looksDubbed?: unknown;
}

type Track = NonNullable<Session['externalSubtitles']>[number];

export interface DirectSubtitleTracks {
  subtitles: NonNullable<Session['subtitles']>;
  tracks: Track[];
  load(language: string): Promise<Track | null>;
  dispose(): void;
}

function language(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const base = value.trim().toLowerCase().split('-')[0];
  return base && /^[a-z]{2,3}$/.test(base) ? base : null;
}

/** A candidate's language, named consistently with the rest of Den. */
function subtitleName(code: string): string {
  let language = code;
  try {
    language =
      new Intl.DisplayNames([globalThis.navigator?.language ?? 'en'], { type: 'language' }).of(
        code,
      ) ?? code;
  } catch {
    // An engine without `Intl.DisplayNames` names the code itself.
  }
  return language;
}

function compactCount(value: number): string {
  try {
    return new Intl.NumberFormat(globalThis.navigator?.language ?? 'en', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  } catch {
    return String(value);
  }
}

/** The same useful OpenSubtitles signals Apple TV puts beneath a language, plus its full release name. */
function candidateDescription(candidate: Candidate): string {
  const facts = ['OpenSubtitles'];
  if (typeof candidate.release === 'string' && candidate.release.trim())
    facts.push(candidate.release.trim());
  if (candidate.hashMatch === true) facts.push('✓ Exact match');
  if (candidate.hd === true) facts.push('HD');
  if (candidate.trusted === true) facts.push('Trusted');
  if (typeof candidate.downloads === 'number' && Number.isFinite(candidate.downloads))
    facts.push(`${compactCount(candidate.downloads)} downloads`);
  if (candidate.machineTranslated === true || candidate.aiTranslated === true)
    facts.push('Auto-translated');
  if (candidate.foreignPartsOnly === true) facts.push('Foreign parts only');
  if (candidate.looksDubbed === true) facts.push('Dubbed release');
  if (typeof candidate.fps === 'number' && Number.isFinite(candidate.fps))
    facts.push(`${candidate.fps} fps`);
  return facts.join(' · ');
}

function candidateUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, globalThis.location?.href ?? 'https://den.invalid/');
    const here = new URL(globalThis.location?.href ?? 'https://den.invalid/');
    return url.origin === here.origin && url.pathname.startsWith('/den/') ? url.href : null;
  } catch {
    return null;
  }
}

function listUrl(
  playback: string,
  want: { imdb: string; season?: number; episode?: number },
  release: Session['release'],
): string | null {
  const base = playback.endsWith('/playback') ? playback.slice(0, -'/playback'.length) : null;
  if (!base) return null;
  const series = want.season !== undefined && want.episode !== undefined;
  const id = series ? `${want.imdb}:${want.season}:${want.episode}` : want.imdb;
  const extra = `filename=${encodeURIComponent(release.filename)}&videoSize=${release.size}`;
  return `${base}/subtitles/${series ? 'series' : 'movie'}/${id}/${extra}.json`;
}

function stageUrl(playback: string): string | null {
  const base = playback.endsWith('/playback') ? playback.slice(0, -'/playback'.length) : null;
  return base ? `${base}/cast-subtitle` : null;
}

function stagedUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /^\/subtitle\/[0-9a-f]{64}\.vtt$/.test(url.pathname)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function webvtt(srt: string): string {
  const normalized = srt.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (/^WEBVTT(?:\s|$)/.test(normalized)) return normalized;
  return `WEBVTT\n\n${normalized.replace(
    /^(\d{1,2}:\d{2}:\d{2}),(\d{3})\s+-->\s+(\d{1,2}:\d{2}:\d{2}),(\d{3})/gm,
    '$1.$2 --> $3.$4',
  )}`;
}

async function boundedText(response: Response, limit = MAX_SUBTITLE_BYTES): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  const reader = response.body?.getReader();
  if (!reader) return null;
  if (Number.isFinite(declared) && declared > limit) {
    await reader.cancel();
    return null;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Lists cheaply; a body is downloaded only when `load` is called for the language the viewer chose. */
export async function directSubtitles(
  playback: string,
  want: { imdb: string; season?: number; episode?: number; subtitleLanguages: string[] },
  release: Session['release'],
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<DirectSubtitleTracks | null> {
  const wanted = [
    ...new Set(want.subtitleLanguages.map(language).filter((one): one is string => !!one)),
  ];
  const url = wanted.length ? listUrl(playback, want, release) : null;
  if (!url) return null;
  const owned = new AbortController();
  const boundedSignal = () => {
    const signals = [owned.signal, AbortSignal.timeout(SUBTITLE_DEADLINE_MS)];
    if (signal) signals.push(signal);
    return AbortSignal.any(signals);
  };
  try {
    const listed = await fetchImpl(url, { cache: 'no-store', signal: boundedSignal() });
    if (!listed.ok) return null;
    const encoded = await boundedText(listed, MAX_LIST_BYTES);
    if (encoded === null) return null;
    const body = JSON.parse(encoded) as { subtitles?: unknown };
    if (!Array.isArray(body.subtitles)) return null;
    const available = new Map<string, { href: string; name: string; description: string }>();
    for (const wantedLanguage of wanted) {
      const href = (body.subtitles as Candidate[]).find((candidate) => {
        if (language(candidate.lang) !== wantedLanguage) return false;
        return candidateUrl(candidate.url) !== null;
      });
      const safe = candidateUrl(href?.url);
      if (safe && href)
        available.set(wantedLanguage, {
          href: safe,
          name: subtitleName(wantedLanguage),
          description: candidateDescription(href),
        });
    }
    if (!available.size) return null;

    const tracks: Track[] = [];
    const loading = new Map<string, Promise<Track | null>>();
    let disposed = false;
    const load = (wantedLanguage: string): Promise<Track | null> => {
      const trackLanguage = language(wantedLanguage);
      if (!trackLanguage || disposed) return Promise.resolve(null);
      const loaded = tracks.find((track) => track.language === trackLanguage);
      if (loaded) return Promise.resolve(loaded);
      const pending = loading.get(trackLanguage);
      if (pending) return pending;
      const candidate = available.get(trackLanguage);
      if (!candidate) return Promise.resolve(null);
      const request = (async () => {
        try {
          const response = await fetchImpl(candidate.href, {
            headers: { accept: 'text/vtt, text/plain' },
            cache: 'no-store',
            signal: boundedSignal(),
          });
          if (!response.ok) return null;
          const text = await boundedText(response);
          if (text === null || disposed) return null;
          const vtt = webvtt(text);
          let castUrl: string | undefined;
          const staging = stageUrl(playback);
          if (staging) {
            try {
              const staged = await fetchImpl(staging, {
                method: 'POST',
                headers: { accept: 'application/json', 'content-type': 'text/vtt; charset=utf-8' },
                body: vtt,
                cache: 'no-store',
                signal: boundedSignal(),
              });
              if (staged.ok)
                castUrl = stagedUrl(
                  ((await staged.json().catch(() => null)) as { url?: unknown } | null)?.url,
                );
            } catch {
              // The local browser track remains useful when Cast staging is unavailable.
            }
          }
          if (disposed) return null;
          const track = {
            language: trackLanguage,
            name: candidate.name,
            url: URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' })),
            ...(castUrl ? { castUrl } : {}),
          };
          if (disposed) {
            URL.revokeObjectURL(track.url);
            return null;
          }
          tracks.push(track);
          return track;
        } catch {
          return null;
        } finally {
          loading.delete(trackLanguage);
        }
      })();
      loading.set(trackLanguage, request);
      return request;
    };
    return {
      subtitles: [...available].map(([language, candidate]) => ({
        language,
        name: candidate.name,
        description: candidate.description,
      })),
      tracks,
      load,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        owned.abort(new DOMException('playback ended', 'AbortError'));
        for (const track of tracks) URL.revokeObjectURL(track.url);
        tracks.length = 0;
      },
    };
  } catch {
    owned.abort();
    return null;
  }
}
