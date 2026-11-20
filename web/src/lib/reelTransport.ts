// Edge's transport negotiation for one carried Reel capability (`/reel/transport`). Only a trailer about to play a
// carried source needs it, so the cursor loads it then and it stays off the startup graph. It imports nothing at
// runtime: a lazy module that imported `reel.ts` would pull that shared module out of its startup chunk.

export interface TransportAttempt {
  type: 'lan' | 'public' | 'relay';
  url: string;
}

interface TransportAnswer {
  attempts: TransportAttempt[];
  ipv4HintWanted: boolean;
}

/**
 * One transport round. Edge bounds its own Reel validation at 2 s and answers without the direct attempts when
 * it is late; only its same-box listener lease may run longer (bounded there at 10 s), and an answer that slow is
 * abandoned here as a failed transport.
 */
const TRANSPORT_MS = 5_000;

function parseTransport(
  value: unknown,
  capability: string,
  expectedRelay: string,
): TransportAnswer | null {
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
      if (attempt.type === 'relay' && attempt.url !== expectedRelay) continue;
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

/**
 * Edge's ordered attempts for `capability`, whose exact configured relay is `relay`. `assumeRelay` says whether that
 * relay may be tried when Edge gives no usable answer; an explicit 403/410 rejection always yields none.
 */
export async function negotiate(
  capability: string,
  relay: TransportAttempt,
  assumeRelay: boolean,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  lookupIpv4: () => Promise<string | undefined>,
): Promise<TransportAttempt[]> {
  const fallback = () => (signal.aborted || !assumeRelay ? [] : [relay]);
  const mount = relay.url.slice(0, relay.url.length - capability.length - 1);
  const ask = async (extra: { ipv4Hint?: string; noHint?: boolean } = {}) => {
    const response = await fetchImpl(`${mount}/transport`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability, ...extra }),
      signal: AbortSignal.any([AbortSignal.timeout(TRANSPORT_MS), signal]),
    });
    if (response.status === 403 || response.status === 410) return { kind: 'rejected' as const };
    if (!response.ok) return { kind: 'failed' as const };
    const answer = parseTransport(await response.json(), capability, relay.url);
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
