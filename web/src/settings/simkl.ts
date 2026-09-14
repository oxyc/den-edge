// SIMKL's PIN sign-in, from the browser as the TV does it (DenKit `SimklClient`): the app's public client id asks for a
// code, the viewer enters it at simkl.com, and asking again with the code hands back the token. No secret is involved,
// and SIMKL answers browsers (CORS `*`). The token goes into the library's `set:keys` as `simkl`, where every device
// finds it and checks it with SIMKL before using it.

const API = 'https://api.simkl.com';

export interface SimklPin {
  userCode: string;
  /** Where the viewer enters the code. */
  verificationUrl: string;
  /** Seconds between asks. */
  interval: number;
  /** Seconds the code lasts. */
  expiresIn: number;
}

export type SimklPoll =
  | { kind: 'authorized'; token: string }
  | { kind: 'pending' }
  | { kind: 'slowDown' }
  | { kind: 'failed' };

/** The client id den-edge publishes for SIMKL (`/config`), or null where it has none. */
export async function fetchSimklClientId(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl('/config', { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const id = ((await res.json()) as { simklClientId?: unknown }).simklClientId;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

async function ask(
  path: string,
  clientId: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const url = new URL(path, API);
  url.searchParams.set('client_id', clientId);
  const res = await fetchImpl(url.href, {
    // SIMKL asks every client to name itself with its key; a browser can't set User-Agent, and sends its own.
    headers: { 'simkl-api-key': clientId },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`SIMKL ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** A code to enter at SIMKL; null when SIMKL wouldn't give one. */
export async function requestPin(
  clientId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SimklPin | null> {
  try {
    const body = await ask('/oauth/pin', clientId, fetchImpl);
    const userCode = body.user_code;
    const verificationUrl = body.verification_url;
    if (typeof userCode !== 'string' || !userCode || typeof verificationUrl !== 'string')
      return null;
    const seconds = (value: unknown, fallback: number) =>
      typeof value === 'number' && value > 0 ? value : fallback;
    return {
      userCode,
      verificationUrl,
      interval: seconds(body.interval, 5),
      expiresIn: seconds(body.expires_in, 900),
    };
  } catch {
    return null;
  }
}

/** Whether the code has been entered yet: SIMKL answers 200 either way, with the token once it has. */
export async function pollToken(
  clientId: string,
  userCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SimklPoll> {
  try {
    const body = await ask(`/oauth/pin/${encodeURIComponent(userCode)}`, clientId, fetchImpl);
    if (typeof body.access_token === 'string' && body.access_token) {
      return { kind: 'authorized', token: body.access_token };
    }
    const message = typeof body.message === 'string' ? body.message.toLowerCase() : '';
    return message.includes('slow') ? { kind: 'slowDown' } : { kind: 'pending' };
  } catch {
    return { kind: 'failed' };
  }
}
