// Connecting an assistant (Claude, ChatGPT) to Den's MCP server (oxyc/den#25). den-edge is the authorization server:
// an assistant sends its person to `/connect?request=<id>`, this browser shows who is asking and says yes or no, and
// den-edge sends the person back to the assistant. Only a library member or a guest with a live invite can say yes;
// `relayFetch` attaches that proof to these calls and to nothing else. Settings › Assistants lists what is
// connected and revokes it.

import { relayFetch } from './relayFetch';

/** What the consent page shows about a request. */
export interface ConsentRequest {
  /** The name the client gave itself when it registered: anyone can register under any name. */
  client: string;
  /** The host the answer is sent back to, which is who is really asking. */
  redirectHost: string | null;
  /** Whether den-edge knows that host as an assistant's own (claude.ai, chatgpt.com) or as this computer. */
  verified: boolean;
}

/** A connected assistant, as Settings lists it. */
export interface Connection {
  sid: string;
  client: string;
  /** The host its approval went back to, which is who really holds it. */
  redirectHost: string | null;
  kind: 'member' | 'guest';
  /** The guest it was connected by, for a member looking at their guests' connections. */
  guest: string | null;
  createdAt: number;
  usedAt: number;
}

export type Reply<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/**
 * The address an assistant connects to (den-edge's `/config` `mcpUrl`): null while the connector is off on this
 * server, undefined when Den couldn't be asked.
 */
export async function fetchMcpUrl(
  fetchImpl: typeof fetch = fetch,
): Promise<string | null | undefined> {
  try {
    const res = await fetchImpl('/config', { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return undefined;
    const url = ((await res.json()) as { mcpUrl?: unknown }).mcpUrl;
    return typeof url === 'string' && safeRedirect(url) ? url : null;
  } catch {
    return undefined;
  }
}

/** The request id `/connect?request=<id>` names, or null for any other address. */
export function consentRequestId(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.pathname !== '/connect') return null;
    const id = url.searchParams.get('request') ?? '';
    return /^[0-9a-f]{32}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

async function ask(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<Reply<unknown>> {
  try {
    const res = await fetchImpl(url, init);
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

export async function consentRequest(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Reply<ConsentRequest>> {
  const reply = await ask(fetchImpl, `/oauth/request/${id}`);
  if (!reply.ok) return reply;
  const body = reply.value as {
    client?: unknown;
    redirectHost?: unknown;
    verified?: unknown;
  } | null;
  if (typeof body?.client !== 'string') return { ok: false, status: 0, error: 'failed' };
  return {
    ok: true,
    value: {
      client: body.client,
      redirectHost: typeof body.redirectHost === 'string' ? body.redirectHost : null,
      verified: body.verified === true,
    },
  };
}

/**
 * Say yes or no. Either way den-edge answers with where to send this browser: back to the assistant, with a code or
 * with `access_denied`. Only an https address, or http to this machine, is followed.
 */
export async function answer(
  id: string,
  allow: boolean,
  fetchImpl: typeof fetch = relayFetch,
): Promise<Reply<string>> {
  const reply = await ask(fetchImpl, `/oauth/request/${id}/${allow ? 'approve' : 'deny'}`, {
    method: 'POST',
  });
  if (!reply.ok) return reply;
  const to = (reply.value as { redirect?: unknown } | null)?.redirect;
  return typeof to === 'string' && safeRedirect(to)
    ? { ok: true, value: to }
    : { ok: false, status: 0, error: 'failed' };
}

export function safeRedirect(to: string): boolean {
  try {
    const url = new URL(to);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    return url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
  } catch {
    return false;
  }
}

function readConnection(raw: unknown): Connection | null {
  const c = raw as Partial<Connection> | null;
  if (typeof c?.sid !== 'string' || typeof c.client !== 'string') return null;
  return {
    sid: c.sid,
    client: c.client,
    redirectHost: typeof c.redirectHost === 'string' ? c.redirectHost : null,
    kind: c.kind === 'guest' ? 'guest' : 'member',
    guest: typeof c.guest === 'string' ? c.guest : null,
    createdAt: typeof c.createdAt === 'number' ? c.createdAt : 0,
    usedAt: typeof c.usedAt === 'number' ? c.usedAt : 0,
  };
}

export async function listConnections(
  fetchImpl: typeof fetch = relayFetch,
): Promise<Reply<Connection[]>> {
  const reply = await ask(fetchImpl, '/oauth/connections');
  if (!reply.ok) return reply;
  const list = (reply.value as { connections?: unknown } | null)?.connections;
  if (!Array.isArray(list)) return { ok: false, status: 0, error: 'failed' };
  return { ok: true, value: list.flatMap((raw) => readConnection(raw) ?? []) };
}

export async function revokeConnection(
  sid: string,
  fetchImpl: typeof fetch = relayFetch,
): Promise<Reply<null>> {
  try {
    const res = await fetchImpl(`/oauth/connections/${sid}`, { method: 'DELETE' });
    return res.ok || res.status === 404
      ? { ok: true, value: null }
      : { ok: false, status: res.status, error: 'failed' };
  } catch {
    return { ok: false, status: 0, error: 'unreachable' };
  }
}
