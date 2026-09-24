// Guest grants (oxyc/den#100): a library owner shares their addons with a named, revocable guest, who plays through
// den-remux without ever holding the owner's install links.
//
// The owner's side talks to `/lib/{id}/grants` with the library's membership proof (`relayFetch` attaches it). The
// guest is NOT a member: they redeem an invite code with a secret this browser generated, and afterwards send
// `x-den-grant: <gid>:<secret>` to that grant's `/<addon>/~<gid>` bases only — `relayFetch` attaches it, same-origin,
// never in a URL. Every secret comes from `crypto.getRandomValues`; den-edge keeps only their SHA-256.

import { hex } from './crypto';
import { relayFetch } from './relayFetch';

export const GRANT_ADDONS = ['scout', 'atlas', 'reel', 'subtitles'] as const;
export type GrantAddon = (typeof GRANT_ADDONS)[number];
export type GrantStatus = 'invited' | 'active' | 'expired' | 'revoked';

/** What den-edge lists of a grant: never a secret, never an install. */
export interface Grant {
  gid: string;
  name: string;
  status: GrantStatus;
  addons: GrantAddon[];
  createdAt: number;
  codeExpiresAt: number;
  accessDays: number | null;
  accessUntil: number | null;
  redeemedAt: number | null;
  /** The effective end of access, ms; null for none. */
  expiresAt: number | null;
  devices: number;
  deviceCount: number;
  lastUsedAt: number | null;
}

/** What creating or changing a grant sends. `installs` are single base64url config segments, never URLs. */
export interface GrantChange {
  name?: string;
  addons?: GrantAddon[];
  installs?: Partial<Record<GrantAddon, string>>;
  codeExpiresAt?: number;
  accessDays?: number;
  accessUntil?: number;
  devices?: number;
}

export type Reply<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const utf8 = new TextEncoder();
export const DAY = 86_400_000;
/** How long an invite code is good for unless the host picks otherwise. */
export const DEFAULT_REDEEM_DAYS = 14;

/**
 * When a code sent from a browser expires, `ahead` ms from `now`. den-edge refuses a date past 90 days from its own
 * clock, so this stays a day short of that for a browser whose clock runs ahead.
 */
export function cappedCodeExpiry(now: number, ahead: number): number {
  return now + Math.min(ahead, 89 * DAY);
}

/** A config segment as den-edge accepts it: base64url, and never a `~` (a virtual install can't be re-shared). */
export const SEGMENT = /^[A-Za-z0-9_-]{1,2048}$/;
const CODE = /^[0-9a-f]{8}\.[A-Za-z0-9_-]{22}$/;
const SHARED_INSTALL = /^\/(scout|atlas|reel|subtitles)\/~([0-9a-f]{8})(?:\/manifest\.json)?\/?$/;

export function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** A device secret: 256 random bits, base64url. */
export function newSecret(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * What den-edge stores of a secret: the SHA-256 of the ASCII bytes of the base64url string, base64url — the very
 * bytes of the header value it later receives, so it hashes exactly what it is sent.
 */
export async function secretHash(secret: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(secret))));
}

/** An invite code from what a guest pasted: the code itself, or a link carrying `#invite=<code>`. */
export function parseInvite(input: string): string | null {
  const text = input.trim();
  const hash = text.split('#')[1];
  const code = hash === undefined ? text : (new URLSearchParams(hash).get('invite') ?? '');
  return CODE.test(code) ? code : null;
}

export function inviteLink(origin: string, code: string): string {
  return `${origin}/#invite=${code}`;
}

const CODES_KEY = 'den.inviteCodes';

/**
 * The codes of the invites this browser made, by grant, so a link can be copied again until it is used. den-edge keeps
 * only a hash, so another browser of the same library has nothing to copy. Only codes of the `unused` grants are kept.
 */
export function keptCodes(
  unused?: readonly string[],
  storage: Storage | undefined = globalThis.localStorage,
): Record<string, string> {
  try {
    const kept = JSON.parse(storage?.getItem(CODES_KEY) ?? '{}') as Record<string, string>;
    if (!unused) return kept;
    const live = Object.fromEntries(Object.entries(kept).filter(([gid]) => unused.includes(gid)));
    if (Object.keys(live).length !== Object.keys(kept).length)
      storage?.setItem(CODES_KEY, JSON.stringify(live));
    return live;
  } catch {
    return {};
  }
}

export function keepCode(
  gid: string,
  code: string,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(CODES_KEY, JSON.stringify({ ...keptCodes(undefined, storage), [gid]: code }));
  } catch {
    // Not kept: the link can still be copied while it is on screen.
  }
}

/** The shared addon a manifest or install URL on this origin names, or null for any other. */
export function sharedInstallOf(
  url: string,
): { addon: GrantAddon; gid: string; path: string; install: string } | null {
  const here = globalThis.location?.href;
  if (!here) return null;
  try {
    const parsed = new URL(url, here);
    const match = SHARED_INSTALL.exec(parsed.pathname);
    if (parsed.origin !== new URL(here).origin || !match) return null;
    const path = `/${match[1]}/~${match[2]}`;
    return {
      addon: match[1] as GrantAddon,
      gid: match[2]!,
      path,
      install: `${parsed.origin}${path}`,
    };
  } catch {
    return null;
  }
}

/** How long is left of an access, in words: "3 days", "5 hours"; "No end date" for none, "Ended" once past. */
export function timeLeft(expiresAt: number | null, now = Date.now()): string {
  if (expiresAt === null) return 'No end date';
  const left = expiresAt - now;
  if (left <= 0) return 'Ended';
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (left >= DAY) return plural(Math.ceil(left / DAY), 'day');
  if (left >= 3_600_000) return plural(Math.ceil(left / 3_600_000), 'hour');
  return plural(Math.max(1, Math.ceil(left / 60_000)), 'minute');
}

/** The picked addons' installs, in a fixed order, hashed — so an unchanged plugin list never re-uploads. */
export async function hashInstalls(
  installs: Partial<Record<GrantAddon, string>>,
  addons: readonly GrantAddon[] = GRANT_ADDONS,
): Promise<string> {
  const picked = GRANT_ADDONS.filter((a) => addons.includes(a)).map((a) => [a, installs[a] ?? '']);
  return hex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(JSON.stringify(picked)))),
  );
}

/** How long a grant request may take; one den-edge never answered left its screen waiting until a reload. */
const ASK_MS = 15_000;

async function ask(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<Reply<unknown>> {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(ASK_MS) });
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (res.ok) return { ok: true, value: body };
    return {
      ok: false,
      status: res.status,
      error: typeof body?.error === 'string' ? body.error : 'failed',
    };
  } catch {
    return { ok: false, status: 0, error: 'unreachable' };
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' };

function readGrant(raw: unknown): Grant | null {
  const g = raw as Partial<Grant> | null;
  const status = g?.status;
  if (
    typeof g?.gid !== 'string' ||
    typeof g.name !== 'string' ||
    !(
      status === 'invited' ||
      status === 'active' ||
      status === 'expired' ||
      status === 'revoked'
    ) ||
    !Array.isArray(g.addons)
  )
    return null;
  const number = (v: unknown) => (typeof v === 'number' ? v : null);
  return {
    gid: g.gid,
    name: g.name,
    status,
    addons: g.addons.filter((a): a is GrantAddon => GRANT_ADDONS.includes(a)),
    createdAt: number(g.createdAt) ?? 0,
    codeExpiresAt: number(g.codeExpiresAt) ?? 0,
    accessDays: number(g.accessDays),
    accessUntil: number(g.accessUntil),
    redeemedAt: number(g.redeemedAt),
    expiresAt: number(g.expiresAt),
    devices: number(g.devices) ?? 1,
    deviceCount: number(g.deviceCount) ?? 0,
    lastUsedAt: number(g.lastUsedAt),
  };
}

const oneGrant = (reply: Reply<unknown>): Reply<Grant> => {
  if (!reply.ok) return reply;
  const grant = readGrant((reply.value as { grant?: unknown } | null)?.grant);
  return grant ? { ok: true, value: grant } : { ok: false, status: 0, error: 'failed' };
};

// The owner's side. `id` is the library's id; the membership proof is attached by `relayFetch`.

/** Invite a guest. The code comes back once and is not kept anywhere. */
export async function createGrant(
  id: string,
  invite: GrantChange & {
    name: string;
    addons: GrantAddon[];
    installs: Partial<Record<GrantAddon, string>>;
  },
  fetchImpl: typeof fetch = relayFetch,
): Promise<Reply<{ code: string; grant: Grant }>> {
  const reply = await ask(fetchImpl, `/lib/${id}/grants`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(invite),
  });
  if (!reply.ok) return reply;
  const body = reply.value as { code?: unknown; grant?: unknown } | null;
  const grant = readGrant(body?.grant);
  return grant && typeof body?.code === 'string'
    ? { ok: true, value: { code: body.code, grant } }
    : { ok: false, status: 0, error: 'failed' };
}

export async function listGrants(
  id: string,
  fetchImpl: typeof fetch = relayFetch,
): Promise<Reply<Grant[]>> {
  const reply = await ask(fetchImpl, `/lib/${id}/grants`);
  if (!reply.ok) return reply;
  const grants = (reply.value as { grants?: unknown } | null)?.grants;
  if (!Array.isArray(grants)) return { ok: false, status: 0, error: 'failed' };
  return { ok: true, value: grants.flatMap((raw) => readGrant(raw) ?? []) };
}

export async function updateGrant(
  id: string,
  gid: string,
  change: GrantChange,
  fetchImpl: typeof fetch = relayFetch,
): Promise<Reply<Grant>> {
  return oneGrant(
    await ask(fetchImpl, `/lib/${id}/grants/${gid}`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(change),
    }),
  );
}

export async function revokeGrant(
  id: string,
  gid: string,
  fetchImpl: typeof fetch = relayFetch,
): Promise<Reply<null>> {
  const reply = await ask(fetchImpl, `/lib/${id}/grants/${gid}`, { method: 'DELETE' });
  return reply.ok ? { ok: true, value: null } : reply;
}

const KEPT = 'den.grants.uploaded';

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function keptHashes(): Record<string, string> {
  try {
    return JSON.parse(storage()?.getItem(KEPT) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

/** Remember what a grant's escrow was last made from, so `reuploadInstalls` leaves it alone until that changes. */
export async function keepUploaded(
  gid: string,
  installs: Partial<Record<GrantAddon, string>>,
  addons: readonly GrantAddon[],
): Promise<void> {
  const kept = { ...keptHashes(), [gid]: await hashInstalls(installs, addons) };
  try {
    storage()?.setItem(KEPT, JSON.stringify(kept));
  } catch {
    // Without storage the next visit uploads once more, which is harmless.
  }
}

/**
 * Re-upload the installs of every live grant whose addons changed in the library's plugins, and return those grants.
 * A grant is left as it is when an addon it shares has no install any more, and when its own addons are unchanged.
 */
export async function reuploadInstalls(
  id: string,
  grants: readonly Grant[],
  installs: Partial<Record<GrantAddon, string>>,
  fetchImpl: typeof fetch = relayFetch,
): Promise<string[]> {
  const updated: string[] = [];
  for (const grant of grants) {
    if (grant.status !== 'invited' && grant.status !== 'active') continue;
    if (!grant.addons.every((addon) => installs[addon])) continue;
    const hash = await hashInstalls(installs, grant.addons);
    if (keptHashes()[grant.gid] === hash) continue;
    const picked = Object.fromEntries(grant.addons.map((addon) => [addon, installs[addon]]));
    const reply = await updateGrant(id, grant.gid, { installs: picked }, fetchImpl);
    if (!reply.ok) continue;
    await keepUploaded(grant.gid, installs, grant.addons);
    updated.push(grant.gid);
  }
  return updated;
}

// The guest's side. These take the grant's secret explicitly: a guest is not a library member.

export type Redeemed = {
  gid: string;
  name: string;
  addons: GrantAddon[];
  expiresAt: number | null;
};

/** Redeem an invite code with a device secret; den-edge stores its hash and starts the access clock. */
export async function redeem(
  code: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Reply<Redeemed>> {
  const reply = await ask(fetchImpl, '/grant/redeem', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ code, secretHash: await secretHash(secret) }),
  });
  if (!reply.ok) return reply;
  const body = reply.value as Partial<Redeemed> | null;
  if (typeof body?.gid !== 'string' || typeof body.name !== 'string' || !Array.isArray(body.addons))
    return { ok: false, status: 0, error: 'failed' };
  return {
    ok: true,
    value: {
      gid: body.gid,
      name: body.name,
      addons: body.addons.filter((a): a is GrantAddon => GRANT_ADDONS.includes(a)),
      expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : null,
    },
  };
}

/** The addons a grant gives now, as `/<addon>/~<gid>` paths. A 410 (`grant_expired`) says the access ended. */
export async function grantAddons(
  gid: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<
  Reply<{ name: string; expiresAt: number | null; addons: Partial<Record<GrantAddon, string>> }>
> {
  const reply = await ask(fetchImpl, '/grant/addons', {
    headers: { 'x-den-grant': `${gid}:${secret}` },
  });
  if (!reply.ok) return reply.status === 410 ? { ...reply, error: 'grant_expired' } : reply;
  const body = reply.value as {
    name?: unknown;
    expiresAt?: unknown;
    addons?: Record<string, unknown>;
  } | null;
  if (typeof body?.name !== 'string' || !body.addons)
    return { ok: false, status: 0, error: 'failed' };
  const addons: Partial<Record<GrantAddon, string>> = {};
  for (const addon of GRANT_ADDONS) {
    const path = body.addons[addon];
    // Only this grant's own base for that addon: anything else isn't something to ask.
    if (path === `/${addon}/~${gid}`) addons[addon] = path;
  }
  return {
    ok: true,
    value: {
      name: body.name,
      expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : null,
      addons,
    },
  };
}

/** Leave a grant: den-edge stops honouring this device's secret. */
export async function leaveGrant(
  gid: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Reply<null>> {
  const reply = await ask(fetchImpl, `/grant/${gid}`, {
    method: 'DELETE',
    headers: { 'x-den-grant': `${gid}:${secret}` },
  });
  return reply.ok ? { ok: true, value: null } : reply;
}
