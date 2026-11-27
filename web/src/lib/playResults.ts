// What a TV says back about a Play on TV request (den-spec wire/play-results-v1.md): preparing, playing, or why not.
// Each result is sealed under a key derived from the request's own random id — the household envelope's `id`, or an
// assistant message's — which only its sender and its receiver read; den-edge stores them opaque by an address derived
// from the same id. playResults.test.ts checks every byte against den-spec's vectors.

import { hex, hkdf } from './crypto';
import { relayFetch } from './relayFetch';
import { fromBase64url, toBase64url } from './wire';

export type PlayResultState = 'preparing' | 'playing' | 'failed';
export type PlayFailure =
  'not_allowed' | 'no_source' | 'no_trailer' | 'expired' | 'superseded' | 'failed';

export interface PlayResult {
  state: PlayResultState;
  /** Only with `failed`. */
  reason?: PlayFailure;
  /** When the TV observed it, by its clock (ms). */
  at: number;
}

const SALT = 'den/play-result/v1';
const PLAINTEXT_BYTES = 128;
const RANK: Record<PlayResultState, number> = { preparing: 1, failed: 2, playing: 3 };
const REASONS = new Set<string>([
  'not_allowed',
  'no_source',
  'no_trailer',
  'expired',
  'superseded',
  'failed',
]);
/** How long a request to den-edge may take; a held read adds its wait. */
const REQUEST_MS = 15_000;
/** den-edge holds a read up to 25 s. */
const WAIT_S = 25;
/** Between reads when one came back early with nothing new (den-edge's held reads per address are capped). */
const EARLY_MS = 2_000;

const utf8 = new TextEncoder();

async function derive(id: string): Promise<{ address: string; key: CryptoKey }> {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new TypeError('a request id is 32 lowercase hex');
  const secret = Uint8Array.from(id.match(/../g)!, (pair) => parseInt(pair, 16));
  const [address, key] = await Promise.all([
    hkdf(secret, SALT, 'address', 16),
    hkdf(secret, SALT, 'key', 32),
  ]);
  return {
    address: hex(address),
    key: await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']),
  };
}

const aadOf = (address: string) => {
  const salt = utf8.encode(SALT);
  const out = new Uint8Array(salt.length + 1 + address.length);
  out.set(salt);
  out.set(utf8.encode(address), salt.length + 1);
  return out;
};

/** The address a request's results are kept under at den-edge. */
export async function resultAddress(id: string): Promise<string> {
  return (await derive(id)).address;
}

/** `result` sealed for request `id`, padded to v1's fixed size. `nonce` is for den-spec's vectors. */
export async function sealResult(
  id: string,
  result: PlayResult,
  nonce: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(12)),
): Promise<{ address: string; sealed: string }> {
  const { address, key } = await derive(id);
  const body = JSON.stringify({
    at: result.at,
    ...(result.state === 'failed' ? { reason: result.reason ?? 'failed' } : {}),
    state: result.state,
    v: 1,
  });
  const plaintext = utf8.encode(body.padEnd(PLAINTEXT_BYTES, ' '));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aadOf(address) },
      key,
      plaintext,
    ),
  );
  const out = new Uint8Array(nonce.length + sealed.length);
  out.set(nonce);
  out.set(sealed, nonce.length);
  return { address, sealed: toBase64url(out) };
}

/** The results among `sealed` that open as request `id`'s, in the order given; anything else counts for nothing. */
export async function openResults(id: string, sealed: readonly string[]): Promise<PlayResult[]> {
  const { address, key } = await derive(id);
  const opened: PlayResult[] = [];
  for (const entry of sealed) {
    try {
      const bytes = fromBase64url(entry);
      if (bytes.length < 29) continue;
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: aadOf(address) },
        key,
        bytes.slice(12),
      );
      const body = JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
      const { v, at, state, reason } = body;
      if (v !== 1 || !Number.isSafeInteger(at)) continue;
      if (state !== 'preparing' && state !== 'playing' && state !== 'failed') continue;
      opened.push({
        state,
        at: at as number,
        ...(state === 'failed'
          ? { reason: (REASONS.has(reason as string) ? reason : 'failed') as PlayFailure }
          : {}),
      });
    } catch {
      // Not sealed under this request's key, or not a result.
    }
  }
  return opened;
}

/** §3 *Order*: the highest state by rank, then the latest `at`; so a reordered or replayed result never moves back. */
export function strongest(results: readonly PlayResult[]): PlayResult | null {
  let best: PlayResult | null = null;
  for (const result of results)
    if (
      !best ||
      RANK[result.state] > RANK[best.state] ||
      (RANK[result.state] === RANK[best.state] && result.at > best.at)
    )
      best = result;
  return best;
}

/**
 * A TV's word on request `id`, sealed and posted with its household member proof. Best effort: a result that cannot be
 * posted leaves its requester at "not confirmed", and never changes playback.
 */
export async function reportResult(
  id: string,
  result: Omit<PlayResult, 'at'>,
  fetchImpl: typeof fetch = relayFetch,
): Promise<void> {
  try {
    const { address, sealed } = await sealResult(id, { ...result, at: Date.now() });
    await fetchImpl('/play/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address, sealed }),
      signal: AbortSignal.timeout(REQUEST_MS),
    });
  } catch (error) {
    console.warn('play/result-post', error);
  }
}

/**
 * Watch request `id`'s results until one is `playing` or `signal` aborts, handing each change of the strongest to
 * `seen`. One held read at a time (`?after=&wait=`), so a TV's answer arrives as it is posted.
 */
export async function watchResults(
  id: string,
  seen: (result: PlayResult) => void,
  signal: AbortSignal,
  fetchImpl: typeof fetch = relayFetch,
): Promise<void> {
  const address = await resultAddress(id);
  let count = 0;
  let shown: PlayResult | null = null;
  while (!signal.aborted) {
    let sealed: string[] | null = null;
    try {
      const res = await fetchImpl(`/play/result/${address}?after=${count}&wait=${WAIT_S}`, {
        cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS + WAIT_S * 1000)]),
      });
      const body = res.ok ? ((await res.json()) as { results?: unknown }) : null;
      if (Array.isArray(body?.results))
        sealed = body.results.filter((r): r is string => typeof r === 'string');
    } catch {
      if (signal.aborted) return;
    }
    if (signal.aborted) return;
    if (!sealed || sealed.length <= count) {
      // An early or failed answer: never ask again at once.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, EARLY_MS);
        signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
      });
      continue;
    }
    count = sealed.length;
    const best = strongest(await openResults(id, sealed));
    if (signal.aborted) return;
    if (best && (best.state !== shown?.state || best.reason !== shown?.reason)) {
      shown = best;
      seen(best);
    }
    if (best?.state === 'playing') return;
  }
}
