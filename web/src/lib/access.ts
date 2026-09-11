// Den's addons on their public names sit behind Cloudflare Access (oxyc/den#15). This page reaches them with the
// library's service token (`set:keys` cfAccessId / cfAccessSecret), sent to the origins den-edge names and nowhere
// else — never to the play tickets' name, whose 302 would carry it on to the debrid, nor to a LAN address — as the
// TV's OriginRoutes does.

import { readApiKey } from './prefs';
import type { SettingsRow } from './wire';

export interface AccessToken {
  id: string;
  secret: string;
}

/** The library's service token: both halves, or none — one without the other opens nothing. */
export function accessToken(keys: SettingsRow | undefined): AccessToken | null {
  const id = readApiKey(keys, 'cfAccessId');
  const secret = readApiKey(keys, 'cfAccessSecret');
  return id && secret ? { id, secret } : null;
}

/** The addon origins behind Access, as den-edge's `/web-config` names them; none when it can't say. */
export async function accessOrigins(fetchImpl: typeof fetch = fetch): Promise<Set<string>> {
  try {
    const res = await fetchImpl('/web-config');
    if (!res.ok) return new Set();
    const access = ((await res.json()) as { access?: unknown }).access;
    return new Set(Array.isArray(access) ? access.filter((o): o is string => typeof o === 'string') : []);
  } catch {
    return new Set();
  }
}

/** `fetch`, adding the token to a request for one of `origins`; a relative URL — this origin — never gets it. */
export function withAccess(origins: Set<string>, token: AccessToken | null, base: typeof fetch): typeof fetch {
  return (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let origin: string | null = null;
    try {
      origin = new URL(href).origin;
    } catch {
      // Relative: this page's own origin.
    }
    if (!token || !origin || !origins.has(origin)) return base(input, init);
    const headers = new Headers(init?.headers);
    headers.set('CF-Access-Client-Id', token.id);
    headers.set('CF-Access-Client-Secret', token.secret);
    return base(input, { ...init, headers });
  };
}
