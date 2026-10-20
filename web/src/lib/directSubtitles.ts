// External subtitles for a managed HLS URL. Hearth deliberately leaves TorBox's media playlist untouched, so the
// browser asks the same configured combined Den addon for its ordinary candidates and lazily owns chosen blob URLs.

import type { Session } from './remux';
import { apiOrigin } from './runtimeUrl';

const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;
// A candidate list is a small JSON document. Keep its browser-side allocation bounded independently of Edge's
// relay cap, both for direct/private deployments and so a changed relay limit cannot silently make this larger.
const MAX_LIST_BYTES = 256 * 1024;
const SUBTITLE_DEADLINE_MS = 10_000;

interface Candidate {
  id?: unknown;
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
  load(value: string): Promise<Track | null>;
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
    const here = new URL(
      __DEN_TV_PACKAGED__
        ? `${apiOrigin()}/`
        : (globalThis.location?.href ?? 'https://den.invalid/'),
    );
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
  builtins: NonNullable<Session['subtitles']> = [],
): Promise<DirectSubtitleTracks | null> {
  const wanted = [
    ...new Set(want.subtitleLanguages.map(language).filter((one): one is string => !!one)),
  ];
  const url = wanted.length ? listUrl(playback, want, release) : null;
  const owned = new AbortController();
  const boundedSignal = () => {
    const signals = [owned.signal, AbortSignal.timeout(SUBTITLE_DEADLINE_MS)];
    if (signal) signals.push(signal);
    return AbortSignal.any(signals);
  };
  const available = new Map<
    string,
    {
      href: string;
      language: string;
      name: string;
      description: string;
      source: 'built-in' | 'opensubtitles';
      fallbackTorboxTrack?: number;
    }
  >();
  for (const track of builtins) {
    const safe = candidateUrl(track.url);
    if (track.delivery !== 'sidecar' || !safe) continue;
    available.set(track.value ?? track.language, {
      href: safe,
      language: track.language,
      name: track.name,
      description: track.description ?? 'Built-in · Indexed sidecar',
      source: 'built-in',
      fallbackTorboxTrack: track.fallbackTorboxTrack,
    });
  }
  try {
    let candidates: Candidate[] = [];
    if (url) {
      try {
        const listed = await fetchImpl(url, { cache: 'no-store', signal: boundedSignal() });
        if (listed.ok) {
          const encoded = await boundedText(listed, MAX_LIST_BYTES);
          if (encoded !== null) {
            const body = JSON.parse(encoded) as { subtitles?: unknown };
            if (Array.isArray(body.subtitles)) candidates = body.subtitles as Candidate[];
          }
        }
      } catch {
        // Indexed built-ins remain usable when the optional OpenSubtitles listing is unavailable or malformed.
      }
    }
    for (const wantedLanguage of wanted) {
      for (const [position, candidate] of candidates.entries()) {
        const candidateLanguage = language(candidate.lang);
        const safe = candidateUrl(candidate.url);
        if (candidateLanguage !== wantedLanguage || !safe) continue;
        const providerId =
          typeof candidate.id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(candidate.id)
            ? candidate.id
            : String(position);
        let value = `opensubtitles:${providerId}`;
        while (available.has(value)) value += `:${position}`;
        available.set(value, {
          href: safe,
          language: candidateLanguage,
          name: subtitleName(candidateLanguage),
          description: candidateDescription(candidate),
          source: 'opensubtitles',
        });
      }
    }
    if (!available.size) return null;

    const tracks: Track[] = [];
    const loading = new Map<string, Promise<Track | null>>();
    let disposed = false;
    const load = (wantedValue: string): Promise<Track | null> => {
      const candidate =
        available.get(wantedValue) ??
        [...available.values()].find((one) => one.language === language(wantedValue));
      if (!candidate || disposed) return Promise.resolve(null);
      const value = available.has(wantedValue)
        ? wantedValue
        : [...available].find(([, one]) => one === candidate)![0];
      const loaded = tracks.find((track) => track.value === value);
      if (loaded) return Promise.resolve(loaded);
      const pending = loading.get(value);
      if (pending) return pending;
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
            value,
            language: candidate.language,
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
          loading.delete(value);
        }
      })();
      loading.set(value, request);
      return request;
    };
    return {
      subtitles: [...available].map(([value, candidate]) => ({
        value,
        language: candidate.language,
        name: candidate.name,
        description: candidate.description,
        source: candidate.source,
        ...(candidate.fallbackTorboxTrack === undefined
          ? {}
          : { fallbackTorboxTrack: candidate.fallbackTorboxTrack, delivery: 'sidecar' as const }),
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
