// The grants this browser holds as a guest, in localStorage only. They are never written to the library log
// (`set:plugins`), so they can't sync to a TV this browser later pairs with, and a library key reset leaves them be.

import { grantAddons, leaveGrant, newSecret, parseInvite, redeem, type GrantAddon } from './grants';
import { forgetGrant, onGrantEnded, rememberGrant } from './relayFetch';

export interface GuestGrant {
  gid: string;
  /** Who shares: the host's name for the invite. */
  name: string;
  /** Empty once den-edge no longer knows the grant: an ended grant that still has one may be extended. */
  secret: string;
  /** `/<addon>/~<gid>` for each addon shared. */
  addons: Partial<Record<GrantAddon, string>>;
  expiresAt: number | null;
  /** den-edge said the access ended (`grant_expired`), or no longer knows this grant. */
  ended: boolean;
}

export type RedeemFailure = 'malformed' | 'invalid' | 'throttled' | 'unreachable';

const KEY = 'den.grants';
/**
 * The secret each code is being redeemed with, by code, until den-edge answers. den-edge keeps the first hash a code
 * is redeemed with and answers a retry only with the same one, and an invite lets one device in: an answer lost on
 * the way, followed by a reload, made a new secret that den-edge refused, and the guest was locked out.
 */
const PENDING_KEY = 'den.grants.pending';

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function isGuestGrant(value: unknown): value is GuestGrant {
  const v = value as Partial<GuestGrant> | null;
  return (
    typeof v?.gid === 'string' &&
    /^[0-9a-f]{8}$/.test(v.gid) &&
    typeof v.name === 'string' &&
    typeof v.secret === 'string' &&
    !!v.addons &&
    typeof v.addons === 'object' &&
    (v.expiresAt === null || typeof v.expiresAt === 'number') &&
    typeof v.ended === 'boolean'
  );
}

/** The secrets kept under `PENDING_KEY`, by code. */
function keptSecrets(): Record<string, string> {
  try {
    const kept = JSON.parse(storage()?.getItem(PENDING_KEY) ?? '{}') as unknown;
    return kept && typeof kept === 'object' && !Array.isArray(kept)
      ? Object.fromEntries(
          Object.entries(kept).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : {};
  } catch {
    return {};
  }
}

/** Keep `secret` as the one `code` is redeemed with, or with null forget it: den-edge answered for good. */
function keepSecret(code: string, secret: string | null): void {
  try {
    const { [code]: _, ...rest } = keptSecrets();
    const next = secret === null ? rest : { ...rest, [code]: secret };
    if (Object.keys(next).length) storage()?.setItem(PENDING_KEY, JSON.stringify(next));
    else storage()?.removeItem(PENDING_KEY);
  } catch {
    // Held for this visit only (`pending`).
  }
}

export class GuestGrants {
  list = $state<GuestGrant[]>([]);
  /** An invite code that arrived in the address (`#invite=…`), waiting for the viewer to redeem it. */
  invite = $state<string | null>(null);
  /**
   * The secret a code was first redeemed with, so a retry after a lost response sends the same hash: kept in storage
   * too (`PENDING_KEY`), which is what a reload reads, and here for a visit whose storage is refused.
   */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Bookkeeping for a retry; nothing renders from it.
  private readonly pending = new Map<string, string>();

  constructor() {
    try {
      const kept = JSON.parse(storage()?.getItem(KEY) ?? '[]') as unknown;
      if (Array.isArray(kept)) this.list = kept.filter(isGuestGrant);
    } catch {
      // Unreadable or refused storage: this visit holds no grants.
    }
    this.sync();
    onGrantEnded((gid) => this.end(gid));
  }

  /** The manifest URLs of the live grants' addons, which the addon lookups read alongside the library's plugins. */
  pluginUrls(): string[] {
    const origin = globalThis.location?.origin;
    if (!origin) return [];
    return this.list.flatMap((grant) =>
      grant.ended
        ? []
        : Object.values(grant.addons).map((path) => `${origin}${path}/manifest.json`),
    );
  }

  /** "Your access to <name> ended", for the first grant that did; null when none has. */
  endedText(): string | null {
    const ended = this.list.find((grant) => grant.ended);
    return ended ? `Your access to ${ended.name} ended` : null;
  }

  /** Redeem a pasted code or link. */
  async redeem(
    input: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<GuestGrant | RedeemFailure> {
    const code = parseInvite(input);
    if (!code) return 'malformed';
    const secret = this.pending.get(code) ?? keptSecrets()[code] ?? newSecret();
    this.pending.set(code, secret);
    // Kept before it is sent: the answer can be lost, and the page reloaded, after den-edge has taken it.
    keepSecret(code, secret);
    const reply = await redeem(code, secret, fetchImpl);
    if (!reply.ok) {
      if (reply.status === 404) {
        this.pending.delete(code);
        keepSecret(code, null);
        return 'invalid';
      }
      return reply.status === 429 ? 'throttled' : 'unreachable';
    }
    this.pending.delete(code);
    keepSecret(code, null);
    const { gid, name, addons, expiresAt } = reply.value;
    const grant: GuestGrant = {
      gid,
      name,
      secret,
      addons: Object.fromEntries(addons.map((addon) => [addon, `/${addon}/~${gid}`])),
      expiresAt,
      ended: false,
    };
    this.set([...this.list.filter((g) => g.gid !== gid), grant]);
    if (this.invite === code) this.invite = null;
    return grant;
  }

  /** Ask den-edge what each held grant gives now: a renamed host, a moved end date, or the access ended. */
  async refresh(fetchImpl: typeof fetch = fetch): Promise<void> {
    const before = JSON.stringify(this.list);
    const next = await Promise.all(
      this.list
        // An expired grant is asked again, since den-edge keeps it for a while so its host can extend it.
        .filter((grant) => grant.secret)
        .map(async (grant): Promise<GuestGrant> => {
          const reply = await grantAddons(grant.gid, grant.secret, fetchImpl);
          if (reply.ok) return { ...grant, ...reply.value, ended: false };
          if (reply.status === 410) return { ...grant, ended: true };
          // Revoked and unknown read alike to den-edge: the access is gone for good, so its secret is dropped.
          if (reply.status === 404) return { ...grant, ended: true, secret: '' };
          return grant;
        }),
    );
    const merged = this.list.map((grant) => next.find((n) => n.gid === grant.gid) ?? grant);
    if (JSON.stringify(merged) !== before) this.set(merged);
  }

  /** Leave a grant. False when den-edge couldn't be reached, which leaves it held so leaving can be retried. */
  async leave(gid: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
    const grant = this.list.find((g) => g.gid === gid);
    if (!grant) return true;
    if (!grant.ended) {
      const reply = await leaveGrant(gid, grant.secret, fetchImpl);
      // An unknown or expired grant is already gone from den-edge's side.
      if (!reply.ok && reply.status !== 404 && reply.status !== 410) return false;
    }
    this.set(this.list.filter((g) => g.gid !== gid));
    return true;
  }

  /** The access ended: keep the grant, so it can say so, and stop relaying with it. `refresh` still asks after it. */
  end(gid: string): void {
    if (this.list.some((g) => g.gid === gid && !g.ended))
      this.set(this.list.map((g) => (g.gid === gid ? { ...g, ended: true } : g)));
  }

  private set(list: GuestGrant[]): void {
    for (const old of this.list) if (!list.some((g) => g.gid === old.gid)) forgetGrant(old.gid);
    this.list = list;
    this.sync();
    try {
      storage()?.setItem(KEY, JSON.stringify(list));
    } catch {
      // Held for this visit only.
    }
  }

  /** Hand the relay the live grants' secrets, and take back an ended one's (the grant itself keeps it). */
  private sync(): void {
    for (const grant of this.list) {
      if (grant.ended) forgetGrant(grant.gid);
      else rememberGrant(grant.gid, grant.secret);
    }
  }
}

export const guestGrants = new GuestGrants();
