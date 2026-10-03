// Recovery codes (den-spec wire/recovery-code.md): making one for the library this browser holds, keeping den-edge's
// entries in step with the library's `set:recovery` row, and opening a library with a code on a new device.
//
// The code and what it derives (`wrapKey`) live only in memory, in the caller, until its screen closes: nothing here
// writes them to storage, to the library, to a log or to a URL. den-core makes, reads and derives (§2, §3); sealing
// the library key under the wrap key is this file's, with WebCrypto (§4).

import { evaluate } from '../vendor/den-core/index.js';
import { hex } from './crypto';
import { readDevices } from '../settings/values';
import {
  deriveKeys,
  fromBase64url,
  fromHex,
  toBase64url,
  type SettingsRow,
  type Stamp,
} from './wire';

const LABEL = 'den/recovery/v1';
const GROUP = 'recovery';
const ROW = `set:${GROUP}`;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Compare-and-set rounds before a write gives up: each lost round means another device wrote the row meanwhile. */
const ROUNDS = 5;
const utf8 = new TextEncoder();

/** One entry of `set:recovery` (§7), keyed by its locator. */
export interface RecoveryEntry {
  state: 'pending' | 'live';
  library: string;
  sealed: string;
  createdAt: number;
  by: string;
}

/** What `set:recovery` needs of the library log: its row, and compare-and-set writes of it. */
export interface RecoveryLog {
  settings(name: string): SettingsRow | undefined;
  seqOf(name: string): number;
  writeAt(row: SettingsRow, base: number): Promise<boolean>;
  refresh(): Promise<boolean>;
  readonly readOnly: boolean;
  /** The newest stamp read, seen before each write so a stamp issued here is later than any in the row. */
  newestStamp?(): Stamp;
}

export interface RecoveryContext {
  log: RecoveryLog;
  /** The library's id and member proof, as `x-den-library-member` carries them. */
  libraryId: string;
  member: string;
  /** This browser's stamp device id. */
  device: string;
  issue: () => Stamp;
  fetchImpl?: typeof fetch;
  now?: () => number;
  storage?: Storage;
}

/** The context for the library `libraryKey` (base64) opens. */
export async function recoveryContext(
  libraryKey: string,
  log: RecoveryLog,
  clock: { device: string; issue: () => Stamp; see: (stamp: Stamp) => void },
): Promise<RecoveryContext> {
  const keys = await deriveKeys(Uint8Array.from(atob(libraryKey), (c) => c.charCodeAt(0)));
  return {
    log,
    libraryId: keys.id,
    member: keys.member,
    device: clock.device,
    issue: () => {
      // Settings and the session each hold a clock of this browser's; seeing the row's newest stamp keeps the two
      // from issuing the same one.
      const newest = log.newestStamp?.();
      if (newest) clock.see(newest);
      return clock.issue();
    },
  };
}

// ---- den-core

type Policy<T> = { ok: T } | { error: string };

function policy<T>(request: Record<string, unknown>): Policy<T> {
  const envelope = JSON.parse(evaluate(JSON.stringify(request))) as {
    ok?: T;
    error?: string;
  };
  return envelope.error !== undefined || envelope.ok === undefined
    ? { error: envelope.error ?? 'protocol_mismatch' }
    : { ok: envelope.ok };
}

/** §2: a new code from 22 bytes of this browser's CSPRNG. */
export function newCode(random = crypto.getRandomValues(new Uint8Array(22))): {
  code: string;
  data: string;
} {
  const made = policy<{ code: string; data: string }>({ op: 'recovery_code', random: hex(random) });
  if ('error' in made) throw new Error(`recovery_code: ${made.error}`);
  return made.ok;
}

/** §2: what was typed, as the code's data characters, or why it can't be one. Before any request. */
export function readCode(text: string): { data: string } | { error: 'mistyped' | 'checksum' } {
  const read = policy<{ data: string }>({ op: 'recovery_read', text });
  if ('error' in read) return { error: read.error === 'checksum' ? 'checksum' : 'mistyped' };
  return read.ok;
}

export interface Derived {
  locator: string;
  wrapKey: Uint8Array<ArrayBuffer>;
}

/** §3: Argon2id then HKDF, in a worker so the page keeps drawing; on the page's thread only where there is none. */
export function derive(data: string): Promise<Derived> {
  const answer = (out: { locator?: string; wrapKey?: string; error?: string }): Derived => {
    if (!out.locator || !out.wrapKey) throw new Error(`recovery_derive: ${out.error ?? 'failed'}`);
    return { locator: out.locator, wrapKey: fromHex(out.wrapKey) };
  };
  if (typeof Worker === 'undefined') {
    const derived = policy<{ locator: string; wrapKey: string }>({ op: 'recovery_derive', data });
    return Promise.resolve(answer('error' in derived ? derived : derived.ok));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./recoveryWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (
      event: MessageEvent<{ locator?: string; wrapKey?: string; error?: string }>,
    ) => {
      worker.terminate();
      try {
        resolve(answer(event.data));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(`recovery worker: ${event.message}`));
    };
    worker.postMessage(data);
  });
}

// ---- §4 the sealed library key

function additionalData(locator: string): Uint8Array<ArrayBuffer> {
  const label = utf8.encode(LABEL);
  const ad = new Uint8Array(label.length + 16);
  ad.set(label);
  ad.set(fromHex(locator), label.length);
  return ad;
}

async function aesKey(wrapKey: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', wrapKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** `nonce ‖ ciphertext ‖ tag`, base64url, of the library key (32 bytes) and when the code was made. */
export async function seal(
  derived: Derived,
  libraryKey: Uint8Array,
  createdAt: number,
  nonce = crypto.getRandomValues(new Uint8Array(12)),
): Promise<string> {
  const plaintext = JSON.stringify({ v: 1, libraryKey: toBase64url(libraryKey), createdAt });
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: additionalData(derived.locator) },
    await aesKey(derived.wrapKey),
    utf8.encode(plaintext),
  );
  const out = new Uint8Array(12 + sealed.byteLength);
  out.set(nonce);
  out.set(new Uint8Array(sealed), 12);
  return toBase64url(out);
}

/** The library key a sealed entry holds; null for one that does not open or holds no 32-byte key. */
export async function unseal(
  derived: Derived,
  sealed: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const bytes = fromBase64url(sealed);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: additionalData(derived.locator) },
      await aesKey(derived.wrapKey),
      bytes.slice(12),
    );
    const body = JSON.parse(new TextDecoder().decode(plain)) as { libraryKey?: unknown };
    if (typeof body.libraryKey !== 'string') return null;
    const key = fromBase64url(body.libraryKey);
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

// ---- den-edge (§5)

interface Listed {
  locator: string;
  createdAt: number;
  opens: number;
  lastOpenedAt: number | null;
}

function call(ctx: RecoveryContext, method: string, body?: unknown): Promise<Response> {
  return (ctx.fetchImpl ?? fetch)('/recovery', {
    method,
    headers: {
      'x-den-library-member': `${ctx.libraryId}:${ctx.member}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function post(
  ctx: RecoveryContext,
  locator: string,
  sealed: string,
): Promise<'ok' | 'full' | 'taken' | 'failed'> {
  try {
    const res = await call(ctx, 'POST', { locator, sealed });
    if (res.ok) return 'ok';
    const code = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
    return code === 'recovery_full' ? 'full' : code === 'locator_taken' ? 'taken' : 'failed';
  } catch {
    return 'failed';
  }
}

async function list(ctx: RecoveryContext): Promise<Listed[] | null> {
  try {
    const res = await call(ctx, 'GET');
    if (!res.ok) return null;
    return ((await res.json()) as { entries: Listed[] }).entries;
  } catch {
    return null;
  }
}

/** Best effort: a delete that fails is left to the next reconcile. */
async function remove(ctx: RecoveryContext, locator: string): Promise<void> {
  try {
    await call(ctx, 'DELETE', { locator });
  } catch (error) {
    console.warn('den: a recovery entry was not deleted; the next check retries', error);
  }
}

// ---- §7 `set:recovery`

/** The row's entries that are still entries: a null is an ended one, and an unreadable value is no code. */
export function readRecovery(row: SettingsRow | undefined): Map<string, RecoveryEntry> {
  const entries = new Map<string, RecoveryEntry>();
  for (const [locator, stamped] of Object.entries(row?.values ?? {})) {
    const value = stamped.value;
    if (!value || !('string' in value) || !/^[0-9a-f]{32}$/.test(locator)) continue;
    try {
      const entry = JSON.parse(value.string) as Partial<RecoveryEntry>;
      if (
        (entry.state === 'pending' || entry.state === 'live') &&
        typeof entry.library === 'string' &&
        typeof entry.sealed === 'string' &&
        typeof entry.createdAt === 'number' &&
        typeof entry.by === 'string'
      )
        entries.set(locator, entry as RecoveryEntry);
    } catch {
      // Not an entry this build reads.
    }
  }
  return entries;
}

/**
 * One compare-and-set write of `set:recovery`, decided on the row as read: `decide` gives the changes, or null for
 * none. A conflict reads the row again and decides again. False when den-edge couldn't be reached or the row kept
 * changing.
 */
async function update(
  ctx: RecoveryContext,
  decide: (entries: Map<string, RecoveryEntry>) => Record<string, RecoveryEntry | null> | null,
): Promise<boolean> {
  for (let round = 0; round < ROUNDS; round++) {
    const row = ctx.log.settings(GROUP);
    const changes = decide(readRecovery(row));
    if (!changes || !Object.keys(changes).length) return true;
    const base = ctx.log.seqOf(ROW);
    if (await write(ctx, row, base, changes)) return true;
    // The same seq means nothing newer came back: den-edge wasn't reached, rather than another device writing first.
    if (ctx.log.seqOf(ROW) === base) return false;
  }
  return false;
}

function write(
  ctx: RecoveryContext,
  row: SettingsRow | undefined,
  base: number,
  changes: Record<string, RecoveryEntry | null>,
): Promise<boolean> {
  const at = ctx.issue();
  const values = { ...(row?.values ?? {}) };
  for (const [locator, entry] of Object.entries(changes))
    values[locator] = { value: entry ? { string: JSON.stringify(entry) } : null, at };
  return ctx.log.writeAt({ ...(row ?? { kind: 'set', schema: 2, name: GROUP }), values }, base);
}

const ownLive = (ctx: RecoveryContext, entries: Map<string, RecoveryEntry>) =>
  [...entries].filter(([, e]) => e.library === ctx.libraryId && e.state === 'live');

// ---- this browser's makes in progress, so another of its tabs doesn't take one for abandoned

const MAKING = 'den.recovery.making';
const BEAT_MS = 20_000;

function readMaking(storage?: Storage): Record<string, number> {
  try {
    return JSON.parse((storage ?? globalThis.localStorage)?.getItem(MAKING) ?? '{}') as Record<
      string,
      number
    >;
  } catch {
    return {};
  }
}

function writeMaking(making: Record<string, number>, storage?: Storage): void {
  try {
    (storage ?? globalThis.localStorage)?.setItem(MAKING, JSON.stringify(making));
  } catch {
    // This tab's make still finishes; another tab may then take it for abandoned after an hour at most.
  }
}

/** Marks `locator` as being made in this tab until the returned function is called. */
function markMaking(ctx: RecoveryContext, locator: string): () => void {
  const beat = () => writeMaking({ ...readMaking(ctx.storage), [locator]: now(ctx) }, ctx.storage);
  beat();
  const timer = setInterval(beat, BEAT_MS);
  return () => {
    clearInterval(timer);
    const making = readMaking(ctx.storage);
    delete making[locator];
    writeMaking(making, ctx.storage);
  };
}

const now = (ctx: RecoveryContext) => (ctx.now ?? Date.now)();

/**
 * §7 *Abandoned*: pending for more than an hour, or made by this browser in an earlier launch — one no tab of it is
 * making now.
 */
function abandoned(ctx: RecoveryContext, entry: RecoveryEntry, locator: string): boolean {
  if (entry.state !== 'pending') return false;
  if (now(ctx) - entry.createdAt > HOUR) return true;
  const beat = readMaking(ctx.storage)[locator];
  return entry.by === ctx.device && !(beat !== undefined && now(ctx) - beat < 3 * BEAT_MS);
}

// ---- notices (§6 *Notice of change*, §7 *Abandoned*)

const seenKey = (ctx: RecoveryContext) => `den.recovery.seen.${ctx.libraryId}`;

/** The live entry's locator this browser last saw ('' for none), or undefined when it never looked. */
function lastSeen(ctx: RecoveryContext): string | undefined {
  try {
    return (ctx.storage ?? globalThis.localStorage)?.getItem(seenKey(ctx)) ?? undefined;
  } catch {
    return undefined;
  }
}

function see(ctx: RecoveryContext, locator: string): void {
  try {
    (ctx.storage ?? globalThis.localStorage)?.setItem(seenKey(ctx), locator);
  } catch {
    // The notice may show once more.
  }
}

function deviceName(ctx: RecoveryContext, id: string): string {
  return (
    readDevices(ctx.log.settings('devices')).find((device) => device.id === id)?.name ??
    'another device'
  );
}

// ---- making a code (§6)

/** A code made and sealed, held in memory by the screen showing it. */
export interface Prepared {
  code: string;
  locator: string;
  sealed: string;
  createdAt: number;
  /** Its last group, which the person types back. */
  lastGroup: string;
}

/** §6 step 1: a code, its locator, and the library key sealed under it. */
export async function prepare(ctx: RecoveryContext, libraryKey: string): Promise<Prepared> {
  const { code, data } = newCode();
  const derived = await derive(data);
  const createdAt = now(ctx);
  const key = Uint8Array.from(atob(libraryKey), (c) => c.charCodeAt(0));
  const sealed = await seal(derived, key, createdAt);
  key.fill(0);
  derived.wrapKey.fill(0);
  return { code, locator: derived.locator, sealed, createdAt, lastGroup: code.slice(-4) };
}

export type Begun =
  | { ok: true; baseLive: Set<string>; done: () => void }
  | { ok: false; error: 'full' | 'taken' | 'failed' };

/** §6 steps 2–3: the entry pending in the library first, then at den-edge. */
export async function begin(ctx: RecoveryContext, prepared: Prepared): Promise<Begun> {
  const done = markMaking(ctx, prepared.locator);
  let baseLive = new Set<string>();
  const entry: RecoveryEntry = {
    state: 'pending',
    library: ctx.libraryId,
    sealed: prepared.sealed,
    createdAt: prepared.createdAt,
    by: ctx.device,
  };
  const named = await update(ctx, (entries) => {
    baseLive = new Set(ownLive(ctx, entries).map(([locator]) => locator));
    return { [prepared.locator]: entry };
  });
  if (!named) {
    done();
    return { ok: false, error: 'failed' };
  }
  let posted = await post(ctx, prepared.locator, prepared.sealed);
  if (posted === 'full') {
    await reconcile(ctx);
    posted = await post(ctx, prepared.locator, prepared.sealed);
  }
  if (posted !== 'ok') {
    await abandon(ctx, prepared.locator, false);
    done();
    return { ok: false, error: posted };
  }
  return { ok: true, baseLive, done };
}

export type Confirmed = { ok: true } | { ok: false; lost: string } | { ok: false; failed: true };

/**
 * §6 step 5–6: once the person typed the last group, this entry goes live and the previous live one is ended, in one
 * compare-and-set. It loses to a code made meanwhile on another device, or when another device took it for abandoned.
 */
export async function confirm(
  ctx: RecoveryContext,
  prepared: Prepared,
  baseLive: Set<string>,
): Promise<Confirmed> {
  for (let round = 0; round < ROUNDS; round++) {
    const row = ctx.log.settings(GROUP);
    const entries = readRecovery(row);
    const mine = entries.get(prepared.locator);
    const live = ownLive(ctx, entries);
    const newer = live.find(([locator]) => !baseLive.has(locator));
    if (!mine || mine.state !== 'pending' || newer) {
      await abandon(ctx, prepared.locator, false);
      return {
        ok: false,
        lost: newer
          ? `This code wasn’t saved — discard it, a code was just made on ${deviceName(ctx, newer[1].by)}.`
          : 'This code wasn’t saved — discard it, setup took too long.',
      };
    }
    const changes: Record<string, RecoveryEntry | null> = {
      [prepared.locator]: { ...mine, state: 'live' },
    };
    for (const [locator] of live) changes[locator] = null;
    const base = ctx.log.seqOf(ROW);
    if (await write(ctx, row, base, changes)) {
      see(ctx, prepared.locator);
      for (const [locator] of live) await remove(ctx, locator);
      return { ok: true };
    }
    if (ctx.log.seqOf(ROW) === base) return { ok: false, failed: true };
  }
  return { ok: false, failed: true };
}

/** A make that won't finish: its pending entry nulled and deleted at den-edge (§6 step 4, §7). */
export async function abandon(
  ctx: RecoveryContext,
  locator: string,
  deleteFirst = true,
): Promise<void> {
  if (deleteFirst) await remove(ctx, locator);
  await update(ctx, (entries) =>
    entries.get(locator)?.state === 'pending' ? { [locator]: null } : null,
  );
  if (!deleteFirst) await remove(ctx, locator);
}

/** §6 *Turning off*: the live entry nulled, then deleted at den-edge. */
export async function turnOff(ctx: RecoveryContext): Promise<boolean> {
  let ended: string[] = [];
  const done = await update(ctx, (entries) => {
    ended = ownLive(ctx, entries).map(([locator]) => locator);
    return Object.fromEntries(ended.map((locator) => [locator, null]));
  });
  if (!done) return false;
  see(ctx, '');
  for (const locator of ended) await remove(ctx, locator);
  return true;
}

// ---- reconcile (§7)

export interface RecoveryStatus {
  live: {
    locator: string;
    createdAt: number;
    by: string;
    byName: string;
    opens: number;
    lastOpenedAt: number | null;
    /** Posted again by this reconcile: den-edge's count started over. */
    reposted: boolean;
  } | null;
  /** The live entry is missing at den-edge and could not be posted again. */
  broken: boolean;
  /** Messages to show once: a code changed or ended elsewhere, or a make here that didn't finish. */
  notices: string[];
}

/** One live entry of several (a merge after a generation change): the one den-edge lists, then the newest. */
function winner(
  live: [string, RecoveryEntry][],
  listed: Set<string>,
): [string, RecoveryEntry] | undefined {
  return [...live].sort(
    ([a, x], [b, y]) =>
      Number(listed.has(b)) - Number(listed.has(a)) ||
      y.createdAt - x.createdAt ||
      (a < b ? 1 : a > b ? -1 : 0),
  )[0];
}

/**
 * §7 *Reconcile*: den-edge made to match the row. A read-only library (v4 §10 step 3) skips the row writes. Null
 * when den-edge couldn't be read.
 */
export async function reconcile(ctx: RecoveryContext): Promise<RecoveryStatus | null> {
  const listedEntries = await list(ctx);
  if (!listedEntries) return null;
  await ctx.log.refresh();
  const listed = new Set(listedEntries.map((entry) => entry.locator));
  const entries = readRecovery(ctx.log.settings(GROUP));
  const own = [...entries].filter(([, e]) => e.library === ctx.libraryId);
  const live = winner(
    own.filter(([, e]) => e.state === 'live'),
    listed,
  );
  const gone = own.filter(([locator, e]) => abandoned(ctx, e, locator));
  const named = new Set(
    own
      .filter(([locator, e]) => e.state === 'pending' && !abandoned(ctx, e, locator))
      .map(([locator]) => locator),
  );
  if (live) named.add(live[0]);
  for (const locator of listed) if (!named.has(locator)) await remove(ctx, locator);
  if (!ctx.log.readOnly)
    await update(ctx, (current) => {
      const nulls: Record<string, null> = {};
      for (const [locator, e] of current) {
        const foreign = e.library !== ctx.libraryId;
        const stale = e.state === 'live' && live && locator !== live[0];
        if (foreign || stale || abandoned(ctx, e, locator)) nulls[locator] = null;
      }
      return nulls;
    });

  const notices: string[] = [];
  if (gone.some(([, e]) => e.by === ctx.device))
    notices.push(
      'Your recovery code setup didn’t finish. The code you saw doesn’t work; make a new one.',
    );
  let broken = false;
  let reposted = false;
  if (live && !listed.has(live[0])) {
    reposted = (await post(ctx, live[0], live[1].sealed)) === 'ok';
    broken = !reposted;
  }
  const seen = lastSeen(ctx);
  const current = live?.[0] ?? '';
  if (seen && seen !== current)
    notices.push(
      live
        ? `A new recovery code was made on ${deviceName(ctx, live[1].by)}. The code you had no longer works.`
        : 'Your recovery code was turned off on another device.',
    );
  see(ctx, current);
  const counted = live && listedEntries.find((entry) => entry.locator === live[0]);
  return {
    live: live
      ? {
          locator: live[0],
          createdAt: live[1].createdAt,
          by: live[1].by,
          byName: deviceName(ctx, live[1].by),
          opens: reposted ? 0 : (counted?.opens ?? 0),
          lastOpenedAt: reposted ? null : (counted?.lastOpenedAt ?? null),
          reposted,
        }
      : null,
    broken,
    notices,
  };
}

const RECONCILED = 'den.recovery.reconciledAt.';

/** At launch, at most once a day (§7): whether this browser should reconcile now, and that it did. */
export function dueAtLaunch(libraryId: string, at = Date.now(), storage?: Storage): boolean {
  try {
    const store = storage ?? globalThis.localStorage;
    const last = Number(store?.getItem(RECONCILED + libraryId) ?? 0);
    if (at - last < DAY) return false;
    store?.setItem(RECONCILED + libraryId, String(at));
    return true;
  } catch {
    return true;
  }
}

// ---- redeeming (§8)

export type RedeemError =
  | 'mistyped'
  | 'checksum'
  | 'unknown_code'
  | 'rate_limited'
  | 'unreadable'
  | 'library_moved'
  | 'unreachable';

/**
 * §8 steps 1–4: the code read, derived and opened, and the library it opens read once. The library key (base64, as a
 * link keeps it) or why not. `retryAfter` (seconds) comes with `rate_limited`.
 */
export async function redeem(
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ libraryKey: string } | { error: RedeemError; retryAfter?: number }> {
  const read = readCode(text);
  if ('error' in read) return read;
  let derived: Derived;
  try {
    derived = await derive(read.data);
  } catch {
    return { error: 'unreachable' };
  }
  try {
    const res = await fetchImpl('/recovery/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locator: derived.locator }),
    });
    if (res.status === 404) return { error: 'unknown_code' };
    if (res.status === 429)
      return { error: 'rate_limited', retryAfter: Number(res.headers.get('retry-after')) || 60 };
    if (!res.ok) return { error: 'unreachable' };
    const key = await unseal(derived, ((await res.json()) as { sealed: string }).sealed);
    derived.wrapKey.fill(0);
    if (!key) return { error: 'unreadable' };
    const keys = await deriveKeys(key);
    const library = await fetchImpl(`/lib/${keys.id}/changes?since=0&limit=1`, {
      headers: { 'x-den-library-token': keys.token },
    });
    if (library.status === 410) return { error: 'library_moved' };
    if (!library.ok) return { error: library.status === 404 ? 'unreadable' : 'unreachable' };
    return { libraryKey: btoa(String.fromCharCode(...key)) };
  } catch {
    return { error: 'unreachable' };
  }
}

export const redeemMessages: Record<RedeemError, string> = {
  mistyped: 'That isn’t a whole recovery code: it’s 24 letters and digits, in six groups of four.',
  checksum: 'That code has a typo. Check it against where you kept it.',
  unknown_code:
    'This code doesn’t open a library. Check it for a typo; it may also have been replaced or turned off.',
  rate_limited: 'Too many tries. Wait a while and try again.',
  unreadable: 'Den couldn’t open what this code points to. Try again later.',
  library_moved: 'This code is out of date: the library’s key was reset after it was made.',
  unreachable: 'Couldn’t reach Den. Check that this device is on your network.',
};
