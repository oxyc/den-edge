// Den Reel's v2 playback contract. Reel decides which logical sources exist; Edge decides how an
// opaque Reel capability reaches this browser; the surface only mounts the current attempt.

import type { MediaType } from './library';
import { ipv4Hint } from './ipv4';
import { relayFetch } from './relayFetch';
import type { Entry, Routes } from './routes';

export interface TitleIds {
  tmdb?: number;
  imdb?: string;
}

export type Surface = 'silent' | 'audible';
export type Player = 'native' | 'hls.js';

export interface Crop {
  letterboxed: boolean;
  aspect: number;
  rect: [number, number, number, number];
}

export interface ExternalDelivery {
  type: 'external';
  url: string;
}

export interface ReelDelivery {
  type: 'reel';
  capability: string;
}

export interface LogicalSource {
  kind: 'mp4' | 'hls';
  audio: boolean;
  width: number | null;
  height: number | null;
  delivery: ExternalDelivery | ReelDelivery;
}

export interface SourcePlan {
  v: 2;
  expires: number;
  crop: Crop | null;
  sources: LogicalSource[];
}

export interface TrailerCandidate {
  planUrl: string;
  plan?: SourcePlan | null;
}

export interface SourceAsk {
  surface: Surface;
  player: Player;
  intent?: 'warm';
  playable?: unknown;
}

export type PlaybackAttempt = 'external' | 'lan' | 'public' | 'relay';

export interface PlaybackStep {
  key: string;
  candidate: number;
  source: number;
  attempt: number;
  attemptType: PlaybackAttempt;
  url: string;
  kind: 'mp4' | 'hls';
  audio: boolean;
  width: number | null;
  height: number | null;
  crop: Crop | null;
}

interface TransportAttempt {
  type: Exclude<PlaybackAttempt, 'external'>;
  url: string;
}

interface TransportAnswer {
  attempts: TransportAttempt[];
  ipv4HintWanted: boolean;
}

export interface PlaybackCursorOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  lookupIpv4?: () => Promise<string | undefined>;
  /** A surface can reject a source it cannot mount, without inventing a different fallback order. */
  accepts?: (source: LogicalSource) => boolean;
}

const CAPABILITY = /^m\/s\/[A-Za-z0-9_-]{40,2048}\?s=[0-9a-fA-F]{24}$/;
const PLAN_TTL_MS = 5 * 60_000;
const prepared = new Map<string, { until: number; candidates: TrailerCandidate[] }>();

/** Forget prepared play answers. Tests ask the same title twice and mean it both times. */
export function forgetWarmedTrailers(): void {
  prepared.clear();
}

function localHost(host: string): boolean {
  const name = host.toLowerCase();
  if (
    name === 'localhost' ||
    name === '127.0.0.1' ||
    name === '[::1]' ||
    name.endsWith('.local') ||
    name.endsWith('.ts.net')
  )
    return true;
  const labels = name.split('.');
  if (labels.length !== 4 || !labels.every((label) => /^\d{1,3}$/.test(label) && +label <= 255))
    return false;
  const [a = -1, b = -1] = labels.map(Number);
  return (
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function reachable(
  entries: Entry[],
  secure = globalThis.location?.protocol !== 'http:',
  here = globalThis.location?.hostname ?? '',
): string | null {
  const pageIsLocal = here !== '' && localHost(here);
  for (const entry of entries) {
    if (entry.access || (secure && entry.url.startsWith('http:'))) continue;
    try {
      if (!pageIsLocal && localHost(new URL(entry.url).hostname)) continue;
      return entry.url.replace(/\/$/, '');
    } catch {
      // An address the browser cannot resolve is not a media origin.
    }
  }
  return null;
}

function mediaBase(base: string, entries: Entry[], secure: boolean): string | null {
  if (base.startsWith('/')) return `/${base.split('/')[1]}`;
  return reachable(entries, secure);
}

function prepareUrl(
  base: string,
  type: MediaType,
  ids: TitleIds,
  ask: SourceAsk,
  height?: number,
): string | null {
  const id = ids.tmdb !== undefined ? `tmdb:${ids.tmdb}` : ids.imdb && encodeURIComponent(ids.imdb);
  if (!id) return null;
  const query = new URLSearchParams({
    v: '2',
    surface: ask.surface,
    player: ask.player,
    intent: ask.intent ?? 'play',
  });
  if (ask.playable) query.set('playable', JSON.stringify(ask.playable));
  if (height) query.set('height', String(height));
  if (ids.tmdb !== undefined && ids.imdb) query.set('imdb', ids.imdb);
  return `${base}/prepare/${type === 'tv' ? 'series' : 'movie'}/${id}.json?${query}`;
}

function planUrl(raw: unknown, base: string, origin: string): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!/\/sources\/[^/]+$/.test(url.pathname)) return null;
    if (!base.startsWith('/')) {
      const selected = new URL(origin);
      return url.origin === selected.origin
        ? `${selected.origin}${url.pathname}${url.search}`
        : null;
    }
    const install = base.replace(/\/$/, '');
    const mount = `/${install.split('/')[1]}`;
    let path: string;
    if (url.pathname.startsWith(`${install}/sources/`)) path = url.pathname;
    else if (url.pathname.startsWith(`${mount}/sources/`)) path = url.pathname;
    else if (url.pathname.startsWith('/sources/')) path = `${mount}${url.pathname}`;
    else return null;
    return `${path}${url.search}`;
  } catch {
    return null;
  }
}

function finiteDimension(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function parseCrop(value: unknown): Crop | null {
  if (!value || typeof value !== 'object') return null;
  const { letterboxed, aspect, rect } = value as Partial<Crop>;
  if (letterboxed !== true || typeof aspect !== 'number' || !Number.isFinite(aspect)) return null;
  if (!Array.isArray(rect) || rect.length !== 4 || rect.some((n) => !Number.isFinite(n)))
    return null;
  return { letterboxed: true, aspect, rect: rect as Crop['rect'] };
}

/** The only parser for Reel's versioned playback plan. Invalid entries are unusable, never guessed. */
export function parseSourcePlan(value: unknown): SourcePlan | null {
  if (!value || typeof value !== 'object') return null;
  const answer = value as {
    v?: unknown;
    expires?: unknown;
    crop?: unknown;
    sources?: unknown;
  };
  if (
    answer.v !== 2 ||
    typeof answer.expires !== 'number' ||
    !Number.isFinite(answer.expires) ||
    answer.expires <= 0 ||
    !Array.isArray(answer.sources)
  )
    return null;
  const sources: LogicalSource[] = [];
  for (const value of answer.sources) {
    if (!value || typeof value !== 'object') continue;
    const source = value as {
      kind?: unknown;
      audio?: unknown;
      width?: unknown;
      height?: unknown;
      delivery?: unknown;
    };
    if (source.kind !== 'mp4' && source.kind !== 'hls') continue;
    if (!source.delivery || typeof source.delivery !== 'object') continue;
    const delivery = source.delivery as {
      type?: unknown;
      url?: unknown;
      capability?: unknown;
    };
    let parsed: ExternalDelivery | ReelDelivery | null = null;
    if (delivery.type === 'external' && typeof delivery.url === 'string') {
      try {
        const url = new URL(delivery.url);
        if (url.protocol === 'http:' || url.protocol === 'https:')
          parsed = { type: 'external', url: url.href };
      } catch {
        // An external delivery must be a complete network URL.
      }
    } else if (
      delivery.type === 'reel' &&
      typeof delivery.capability === 'string' &&
      CAPABILITY.test(delivery.capability)
    ) {
      parsed = { type: 'reel', capability: delivery.capability };
    }
    if (!parsed) continue;
    sources.push({
      kind: source.kind,
      audio: source.audio === true,
      width: finiteDimension(source.width),
      height: finiteDimension(source.height),
      delivery: parsed,
    });
  }
  if (!sources.length) return null;
  return {
    v: 2,
    expires: answer.expires,
    crop: parseCrop(answer.crop),
    sources,
  };
}

function candidatesFrom(value: unknown, base: string, origin: string): TrailerCandidate[] {
  if (!value || typeof value !== 'object') return [];
  const answer = value as {
    v?: unknown;
    meta?: { links?: unknown };
    primary?: { planUrl?: unknown } | null;
    primaryPlan?: unknown;
  };
  if (answer.v !== 2 || !Array.isArray(answer.meta?.links)) return [];
  const primaryUrl = planUrl(answer.primary?.planUrl, base, origin);
  const primaryPlan = parseSourcePlan(answer.primaryPlan);
  const candidates: TrailerCandidate[] = [];
  for (const link of answer.meta.links) {
    const url = planUrl((link as { planUrl?: unknown })?.planUrl, base, origin);
    if (!url || candidates.some((candidate) => candidate.planUrl === url)) continue;
    candidates.push({
      planUrl: url,
      // A degraded prepare names the primary but embeds null. Leaving it unloaded lets the cursor
      // retry that exact plan lazily instead of permanently skipping the best candidate.
      ...(url === primaryUrl && primaryPlan ? { plan: primaryPlan } : {}),
    });
  }
  return candidates;
}

/** Discover ordered trailer candidates and, for a play request, embed the primary's ready plan. */
export async function prepareTrailers(
  base: string,
  type: MediaType,
  ids: TitleIds,
  routes: Routes,
  ask: SourceAsk,
  {
    fetchImpl = relayFetch,
    secure = globalThis.location?.protocol !== 'http:',
    signal,
    height,
  }: {
    fetchImpl?: typeof fetch;
    secure?: boolean;
    signal?: AbortSignal;
    height?: number;
  } = {},
): Promise<TrailerCandidate[]> {
  const origin = mediaBase(base, routes.reel ?? [], secure);
  const url = prepareUrl(base, type, ids, ask, height);
  if (!origin || !url) return [];
  const cacheKey = JSON.stringify([
    origin,
    base,
    type,
    ids.tmdb,
    ids.imdb,
    ask.surface,
    ask.player,
    ask.playable ?? null,
    height ?? null,
  ]);
  const cached = prepared.get(cacheKey);
  if (cached && Date.now() < cached.until) return cached.candidates;
  if (cached) prepared.delete(cacheKey);
  try {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) return [];
    const candidates = candidatesFrom(await response.json(), base, origin);
    if (candidates.length) {
      const expires = candidates
        .map((candidate) => candidate.plan?.expires)
        .filter((value): value is number => typeof value === 'number');
      const planUntil = expires.length ? Math.min(...expires) * 1000 : Number.POSITIVE_INFINITY;
      prepared.set(cacheKey, {
        until: Math.min(Date.now() + PLAN_TTL_MS, planUntil),
        candidates,
      });
    }
    return candidates;
  } catch {
    return [];
  }
}

function parseTransport(value: unknown, capability: string): TransportAnswer | null {
  if (!value || typeof value !== 'object') return null;
  const answer = value as {
    v?: unknown;
    capability?: unknown;
    attempts?: unknown;
    ipv4HintWanted?: unknown;
  };
  if (answer.v !== 2 || answer.capability !== capability || !Array.isArray(answer.attempts))
    return null;
  const attempts: TransportAttempt[] = [];
  for (const entry of answer.attempts) {
    const attempt = entry as { type?: unknown; url?: unknown };
    if (
      !['lan', 'public', 'relay'].includes(String(attempt.type)) ||
      typeof attempt.url !== 'string'
    )
      continue;
    try {
      const relative = attempt.url.startsWith('/') && !attempt.url.startsWith('//');
      if ((attempt.type === 'relay') !== relative) continue;
      if (attempt.type === 'relay' && attempt.url !== `/reel/${capability}`) continue;
      const url = new URL(attempt.url, globalThis.location?.href ?? 'https://relative.invalid');
      if (attempt.type !== 'relay' && url.protocol !== 'https:') continue;
      const normalized = relative ? `${url.pathname}${url.search}` : url.href;
      if (attempts.some((had) => had.url === normalized)) continue;
      attempts.push({
        type: attempt.type as TransportAttempt['type'],
        url: normalized,
      });
    } catch {
      // One malformed attempt does not discard the remaining ordered attempts.
    }
  }
  return { attempts, ipv4HintWanted: answer.ipv4HintWanted === true };
}

async function transport(
  capability: string,
  planUrl: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  lookupIpv4: () => Promise<string | undefined>,
): Promise<TransportAttempt[]> {
  const relay = (() => {
    if (!planUrl.startsWith('/') || planUrl.startsWith('//')) return null;
    const path = planUrl.split('?', 1)[0] ?? '';
    const marker = path.lastIndexOf('/sources/');
    if (marker <= 0) return null;
    const mount = path.slice(0, marker);
    return CAPABILITY.test(capability)
      ? ({ type: 'relay', url: `${mount}/${capability}` } satisfies TransportAttempt)
      : null;
  })();
  const fallback = () => (signal.aborted || !relay ? [] : [relay]);
  const ask = async (extra: { ipv4Hint?: string; noHint?: boolean } = {}) => {
    if (!relay) return { kind: 'failed' as const };
    const mount = relay.url.slice(0, relay.url.length - capability.length - 1);
    const response = await fetchImpl(`${mount}/transport`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability, ...extra }),
      signal,
    });
    if (response.status === 403 || response.status === 410) return { kind: 'rejected' as const };
    if (!response.ok) return { kind: 'failed' as const };
    const answer = parseTransport(await response.json(), capability);
    return answer ? { kind: 'answer' as const, answer } : { kind: 'failed' as const };
  };
  try {
    let result = await ask();
    if (result.kind === 'rejected' || signal.aborted) return [];
    if (result.kind === 'failed') return fallback();
    if (!result.answer.ipv4HintWanted) return result.answer.attempts;
    const hint = await lookupIpv4();
    if (signal.aborted) return [];
    result = await ask(hint ? { ipv4Hint: hint } : { noHint: true });
    if (result.kind === 'rejected' || signal.aborted) return [];
    return result.kind === 'answer' ? result.answer.attempts : fallback();
  } catch {
    return fallback();
  }
}

/**
 * One deterministic cursor across candidates, logical sources, and Edge's transport attempts.
 * Reel capabilities stay opaque until they become current. Closing the cursor aborts every pending request.
 */
export class PlaybackCursor {
  readonly #candidates: TrailerCandidate[];
  readonly #fetch: typeof fetch;
  readonly #lookupIpv4: () => Promise<string | undefined>;
  readonly #accepts: (source: LogicalSource) => boolean;
  readonly #controller = new AbortController();
  readonly #parent?: AbortSignal;
  #candidate = 0;
  #source = 0;
  #attempt = 0;
  #attempts: Array<{ type: PlaybackAttempt; url: string }> = [];
  #current: PlaybackStep | null = null;
  #pending: Promise<PlaybackStep | null> | null = null;
  #closed = false;

  constructor(candidates: TrailerCandidate[], options: PlaybackCursorOptions = {}) {
    // Lazy alternate-plan loads are cursor-local. A cached discovery answer is immutable shared input,
    // not state for whichever surface happened to consume it first.
    this.#candidates = candidates.map((candidate) => ({ ...candidate }));
    this.#fetch = options.fetchImpl ?? relayFetch;
    this.#lookupIpv4 = options.lookupIpv4 ?? (() => ipv4Hint());
    this.#accepts = options.accepts ?? (() => true);
    this.#parent = options.signal;
    if (this.#parent?.aborted) this.close();
    else this.#parent?.addEventListener('abort', this.#abort, { once: true });
  }

  get current(): PlaybackStep | null {
    return this.#current;
  }

  async first(): Promise<PlaybackStep | null> {
    if (this.#current) return this.#current;
    return this.#run(() => this.#seek());
  }

  async next(): Promise<PlaybackStep | null> {
    if (this.#closed) return null;
    return this.#run(async () => {
      if (this.#attempt + 1 < this.#attempts.length) {
        this.#attempt += 1;
        return this.#publish();
      }
      this.#source += 1;
      this.#attempt = 0;
      this.#attempts = [];
      this.#current = null;
      return this.#seek();
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#parent?.removeEventListener('abort', this.#abort);
    this.#controller.abort(new DOMException('playback cursor closed', 'AbortError'));
    this.#current = null;
  }

  readonly #abort = () => this.close();

  #run(work: () => Promise<PlaybackStep | null>): Promise<PlaybackStep | null> {
    // Media elements may report the same terminal failure through both the player engine and the
    // element. Both observers join the same move instead of skipping two ordered attempts.
    if (this.#pending) return this.#pending;
    const pending = work().finally(() => {
      if (this.#pending === pending) this.#pending = null;
    });
    this.#pending = pending;
    return pending;
  }

  async #seek(): Promise<PlaybackStep | null> {
    while (!this.#closed) {
      const candidate = this.#candidates[this.#candidate];
      if (!candidate) return null;
      let plan = candidate.plan;
      if (plan !== null && (plan === undefined || plan.expires * 1000 <= Date.now())) {
        plan = await this.#fetchPlan(candidate.planUrl);
        candidate.plan = plan && plan.expires * 1000 > Date.now() ? plan : null;
        plan = candidate.plan;
      }
      if (this.#closed) return null;
      if (!plan) {
        this.#nextCandidate();
        continue;
      }
      const source = plan.sources[this.#source];
      if (!source) {
        this.#nextCandidate();
        continue;
      }
      if (!this.#accepts(source)) {
        this.#source += 1;
        continue;
      }
      this.#attempts =
        source.delivery.type === 'external'
          ? [{ type: 'external', url: source.delivery.url }]
          : await transport(
              source.delivery.capability,
              candidate.planUrl,
              this.#fetch,
              this.#controller.signal,
              this.#lookupIpv4,
            );
      if (this.#closed) return null;
      if (!this.#attempts.length) {
        this.#source += 1;
        continue;
      }
      this.#attempt = 0;
      return this.#publish();
    }
    return null;
  }

  async #fetchPlan(url: string): Promise<SourcePlan | null> {
    try {
      const response = await this.#fetch(url, {
        signal: this.#controller.signal,
      });
      return response.ok ? parseSourcePlan(await response.json()) : null;
    } catch {
      return null;
    }
  }

  #nextCandidate(): void {
    this.#candidate += 1;
    this.#source = 0;
    this.#attempt = 0;
    this.#attempts = [];
  }

  #publish(): PlaybackStep | null {
    const candidate = this.#candidates[this.#candidate];
    const source = candidate?.plan?.sources[this.#source];
    const attempt = this.#attempts[this.#attempt];
    if (!candidate?.plan || !source || !attempt) return null;
    return (this.#current = {
      key: `${this.#candidate}:${this.#source}:${this.#attempt}:${attempt.url}`,
      candidate: this.#candidate,
      source: this.#source,
      attempt: this.#attempt,
      attemptType: attempt.type,
      url: attempt.url,
      kind: source.kind,
      audio: source.audio,
      width: source.width,
      height: source.height,
      crop: candidate.plan.crop,
    });
  }
}

/** A visible direct attempt gets a bounded chance to produce a decoded frame before the cursor advances. */
export function watchPlaybackAttempt(
  player: HTMLMediaElement,
  step: PlaybackStep | null | undefined,
  failed: () => void,
  ms = 2_000,
): () => void {
  if (
    !step ||
    (step.attemptType !== 'lan' && step.attemptType !== 'public') ||
    player.readyState >= 2
  )
    return () => {};
  const timer = setTimeout(() => {
    if (player.readyState < 2) failed();
  }, ms);
  const arrived = () => clearTimeout(timer);
  player.addEventListener('loadeddata', arrived, { once: true });
  return () => {
    clearTimeout(timer);
    player.removeEventListener('loadeddata', arrived);
  };
}

export interface HlsSupport {
  claims: () => string;
  apple: boolean;
  mse: boolean;
}

function support(): HlsSupport {
  return {
    claims: () => document.createElement('video').canPlayType('application/vnd.apple.mpegurl'),
    apple: globalThis.navigator?.vendor === 'Apple Computer, Inc.',
    mse: 'MediaSource' in globalThis || 'ManagedMediaSource' in globalThis,
  };
}

export function nativeHls(env: HlsSupport = support()): boolean {
  try {
    return env.claims() !== '' && (env.apple || !env.mse);
  } catch {
    return false;
  }
}

export function cropStyle(crop: Crop | null | undefined): string | null {
  if (!crop?.letterboxed) return null;
  const [x, y, width, height] = crop.rect;
  if (!(width > 0) || !(height > 0)) return null;
  const scale = Math.max(1 / width, 1 / height);
  if (!Number.isFinite(scale) || scale <= 1) return null;
  const origin = `${((x + width / 2) * 100).toFixed(3)}% ${((y + height / 2) * 100).toFixed(3)}%`;
  return `transform: scale(${scale.toFixed(4)}); transform-origin: ${origin};`;
}
