// Pairing v1 (den-spec wire/pairing-v1.md): CPace over ristretto255 on the code a TV shows, relayed by
// den-edge's /pair routes, which never see the secret half of the code. pair.test.ts runs den-spec's vectors —
// the CPace draft's own among them — which the TV runs too.

import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { hex, hkdf } from './crypto';
import { deviceLabel } from './edge';
import { fromBase64url, fromHex, toBase64url } from './wire';

type Bytes = Uint8Array<ArrayBuffer>;
type Point = InstanceType<typeof ristretto255.Point>;
type Role = 'joiner' | 'host';

const utf8 = new TextEncoder();
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DSI = utf8.encode('CPaceRistretto255');
const CI = utf8.encode('den/pair/v1');
const HANDOVER = utf8.encode('den/pair/v1/handover');
const MAX_LABEL = 40;

/** A typed or scanned code: uppercased, spaces and dashes dropped, and refused unless it is 12 alphabet characters. */
export function parseCode(input: string): { nameplate: string; secret: string } | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== 12 || [...code].some((c) => !ALPHABET.includes(c))) return null;
  return { nameplate: code.slice(0, 4), secret: code.slice(4) };
}

/**
 * A code as it is typed: alphabet characters only, at most twelve, in the TV's groups of four. `caret` is where the
 * cursor was in `input`; the result's caret stays after the same characters.
 */
export function formatCode(input: string, caret = input.length): { text: string; caret: number } {
  const keep = (s: string) => [...s.toUpperCase()].filter((c) => ALPHABET.includes(c)).join('');
  const chars = keep(input).slice(0, 12);
  const n = Math.min(keep(input.slice(0, caret)).length, chars.length);
  return { text: chars.match(/.{1,4}/g)?.join('-') ?? '', caret: n + Math.floor(Math.max(n - 1, 0) / 4) };
}

/** What a device calls itself, as the other's list of linked devices shows it. The same rule as den-edge's. */
export function cleanLabel(raw: string): string {
  return [...raw.trim()]
    .filter((c) => !/\p{Cc}/u.test(c))
    .slice(0, MAX_LABEL)
    .join('');
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The draft's prepend_len: a LEB128 length, then the bytes. */
function prependLen(data: Uint8Array): Bytes {
  const length: number[] = [];
  let n = data.length;
  do {
    length.push(n < 128 ? n : (n & 0x7f) | 0x80);
    n >>= 7;
  } while (n > 0);
  return concat(Uint8Array.from(length), data);
}

export const lvCat = (...args: Uint8Array[]): Bytes => concat(...args.map(prependLen));

/** The fields of an lv_cat, or null when its lengths don't add up. */
function lvSplit(data: Uint8Array): Bytes[] | null {
  const fields: Bytes[] = [];
  let at = 0;
  while (at < data.length) {
    let length = 0;
    for (let shift = 0; ; shift += 7) {
      if (at >= data.length || shift > 21) return null;
      const byte = data[at++] ?? 0;
      length += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) break;
    }
    if (at + length > data.length) return null;
    fields.push(data.slice(at, at + length));
    at += length;
  }
  return fields;
}

const sha512 = async (data: Bytes): Promise<Bytes> => new Uint8Array(await crypto.subtle.digest('SHA-512', data));

async function hmac512(key: Bytes, data: Bytes): Promise<Bytes> {
  const mac = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', mac, data));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.reduce((diff, byte, i) => diff | (byte ^ (b[i] ?? 0)), 0) === 0;
}

// --- CPACE-RISTR255-SHA512 (draft-irtf-cfrg-cpace-21 §8.3) ---

function generatorString(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Bytes {
  const zpad = Math.max(0, 128 - 1 - prependLen(prs).length - prependLen(DSI).length);
  return lvCat(DSI, prs, new Uint8Array(zpad), ci, sid);
}

export async function generator(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Promise<Point> {
  const g = ristretto255_hasher.deriveToCurve?.(await sha512(generatorString(prs, ci, sid)));
  if (!g) throw new Error('@noble/curves has no ristretto255 element derivation');
  return g;
}

/** 32 random bytes with the top 4 bits cleared: a scalar below the group order, used for one session. */
export function sampleScalar(): Bytes {
  const y = crypto.getRandomValues(new Uint8Array(32));
  y[31] = (y[31] ?? 0) & 0x0f;
  return y;
}

const scalar = (littleEndian: Uint8Array): bigint => littleEndian.reduceRight((n, byte) => (n << 8n) | BigInt(byte), 0n);

export const scalarMult = (y: Uint8Array, g: Point): Bytes => new Uint8Array(g.multiply(scalar(y)).toBytes());

/** `y` times the encoded point, or the identity (32 zero bytes) when it doesn't decode. */
export function scalarMultVfy(y: Uint8Array, encoded: Uint8Array): Bytes {
  let point: Point;
  try {
    point = ristretto255.Point.fromBytes(encoded);
  } catch {
    return new Uint8Array(32);
  }
  return point.is0() ? new Uint8Array(32) : new Uint8Array(point.multiply(scalar(y)).toBytes());
}

export function intermediateKey(sid: Bytes, K: Bytes, Ya: Bytes, ADa: Bytes, Yb: Bytes, ADb: Bytes): Promise<Bytes> {
  return sha512(concat(lvCat(concat(DSI, utf8.encode('_ISK')), sid, K), lvCat(Ya, ADa), lvCat(Yb, ADb)));
}

// --- Den's layer: associated data, confirmation, handover ---

const partyData = (role: Role, label: string): Bytes => lvCat(utf8.encode(role), utf8.encode(label));

/** The label in a party's associated data, when the role is right and the label is one a device could send. */
function partyLabel(data: Uint8Array, role: Role): string | null {
  const fields = lvSplit(data);
  if (fields?.length !== 2) return null;
  const [given, raw] = fields as [Bytes, Bytes];
  try {
    const label = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    return new TextDecoder().decode(given) === role && label && cleanLabel(label) === label ? label : null;
  } catch {
    return null;
  }
}

interface SessionKeys {
  macKey: Bytes;
  handoverKey: Bytes;
}

/** The keys both sides confirm and seal with; null when `K` is the identity, where CPace aborts. */
async function sessionKeys(sid: Bytes, K: Bytes, Ya: Bytes, ADa: Bytes, Yb: Bytes, ADb: Bytes): Promise<SessionKeys | null> {
  if (equal(K, new Uint8Array(32))) return null;
  const isk = await intermediateKey(sid, K, Ya, ADa, Yb, ADb);
  return {
    macKey: await sha512(concat(utf8.encode('CPaceMac'), sid, isk)),
    handoverKey: await hkdf(isk, sid, 'den/pair/v1/handover', 32),
  };
}

export interface JoinerState {
  sid: Bytes;
  y: Bytes;
  Ya: Bytes;
  ADa: Bytes;
}

/** The joiner's first message, `a`. */
export async function joinerStart(secret: string, sid: Bytes, label: string, y = sampleScalar()) {
  const Ya = scalarMult(y, await generator(utf8.encode(secret), CI, sid));
  const ADa = partyData('joiner', label);
  return { state: { sid, y, Ya, ADa } satisfies JoinerState, a: lvCat(Ya, ADa) };
}

/** The joiner checks the host's `b` and answers with its own tag, `c`. Null ends the pairing. */
export async function joinerFinish(state: JoinerState, b: Uint8Array) {
  const fields = lvSplit(b);
  if (fields?.length !== 3) return null;
  const [Yb, ADb, Tb] = fields as [Bytes, Bytes, Bytes];
  const host = Yb.length === 32 && Tb.length === 64 ? partyLabel(ADb, 'host') : null;
  if (host === null) return null;
  const keys = await sessionKeys(state.sid, scalarMultVfy(state.y, Yb), state.Ya, state.ADa, Yb, ADb);
  if (!keys || !equal(Tb, await hmac512(keys.macKey, lvCat(Yb, ADb)))) return null;
  return { c: await hmac512(keys.macKey, lvCat(state.Ya, state.ADa)), handoverKey: keys.handoverKey, host };
}

export interface HostState extends SessionKeys {
  Ya: Bytes;
  ADa: Bytes;
  /** The joiner's label, authenticated once `c` checks out: what "Allow …?" names. */
  joiner: string;
}

/** The host answers the joiner's `a` with `b`. Null ends the pairing. */
export async function hostRespond(secret: string, sid: Bytes, label: string, a: Uint8Array, y = sampleScalar()) {
  const fields = lvSplit(a);
  if (fields?.length !== 2) return null;
  const [Ya, ADa] = fields as [Bytes, Bytes];
  const joiner = Ya.length === 32 ? partyLabel(ADa, 'joiner') : null;
  if (joiner === null) return null;
  const Yb = scalarMult(y, await generator(utf8.encode(secret), CI, sid));
  const ADb = partyData('host', label);
  const keys = await sessionKeys(sid, scalarMultVfy(y, Ya), Ya, ADa, Yb, ADb);
  if (!keys) return null;
  const b = lvCat(Yb, ADb, await hmac512(keys.macKey, lvCat(Yb, ADb)));
  return { state: { ...keys, Ya, ADa, joiner } satisfies HostState, b };
}

/** The host checks the joiner's tag `c`, before asking its user to allow the joiner. */
export async function hostConfirm(state: HostState, c: Uint8Array): Promise<boolean> {
  return equal(c, await hmac512(state.macKey, lvCat(state.Ya, state.ADa)));
}

export interface Handover {
  host: string;
  linkKey: Bytes;
  libraryKey: Bytes;
}

async function aes(key: Bytes, use: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', key, 'AES-GCM', false, [use]);
}

export async function sealHandover(key: Bytes, handover: Handover, nonce = crypto.getRandomValues(new Uint8Array(12))) {
  const plaintext = JSON.stringify({
    v: 1,
    host: handover.host,
    linkKey: toBase64url(handover.linkKey),
    libraryKey: toBase64url(handover.libraryKey),
  });
  const params = { name: 'AES-GCM', iv: nonce, additionalData: HANDOVER };
  return concat(nonce, new Uint8Array(await crypto.subtle.encrypt(params, await aes(key, 'encrypt'), utf8.encode(plaintext))));
}

/** The host's handover, or null when it doesn't open or lacks a key. */
export async function openHandover(key: Bytes, d: Uint8Array): Promise<Handover | null> {
  if (d.length < 12 + 16) return null;
  try {
    const params = { name: 'AES-GCM', iv: d.slice(0, 12), additionalData: HANDOVER };
    const plain = await crypto.subtle.decrypt(params, await aes(key, 'decrypt'), d.slice(12));
    const body = JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
    const linkKey = typeof body.linkKey === 'string' ? fromBase64url(body.linkKey) : null;
    const libraryKey = typeof body.libraryKey === 'string' ? fromBase64url(body.libraryKey) : null;
    if (typeof body.host !== 'string' || linkKey?.length !== 32 || libraryKey?.length !== 32) return null;
    return { host: body.host, linkKey, libraryKey };
  } catch {
    return null;
  }
}

/** What a link key derives: `inbox`, the link's credential at den-edge, and `enc`, its inbox messages' key. */
export async function linkKeys(linkKey: Bytes): Promise<{ inbox: string; enc: Bytes }> {
  const [inbox, enc] = await Promise.all([hkdf(linkKey, 'den/link/v1', 'inbox', 24), hkdf(linkKey, 'den/link/v1', 'enc', 32)]);
  return { inbox: hex(inbox), enc };
}

// --- Joining through den-edge ---

export type JoinError = 'mistyped' | 'expired' | 'claimed' | 'throttled' | 'failed' | 'unreachable' | 'insecure';
export type JoinResult = { handover: Handover; inboxKey: string } | { error: JoinError };

interface JoinOptions {
  label?: string;
  fetchImpl?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
  /** A fixed scalar, for tests. */
  y?: Bytes;
}

/**
 * WebCrypto, which every step of CPace leans on, exists only in a secure context — https, or localhost. Served
 * over plain http on a LAN address there is no `crypto.subtle` at all, and the maths throws halfway through a
 * pairing: a code on one screen and a spinner on the other, with nothing said. Both sides check before they
 * start, so the page can say what is wrong instead.
 */
const secureContext = (): boolean => typeof crypto !== 'undefined' && crypto.subtle !== undefined;

const POLL_MS = 1000;
/** A session's whole life on den-edge: past it, a slot never fills. */
const SESSION_MS = 10 * 60 * 1000;

const OPEN_ERRORS: Record<number, JoinError> = { 409: 'claimed', 410: 'expired', 429: 'throttled' };

/**
 * Join the library of the TV showing `code`: open its session, run CPace through the relay, and wait for the TV's
 * user to allow this device. A failed check, a declined prompt and an expired session all end as `failed`, and
 * the session is deleted, so the TV shows a new code.
 */
/** The four slots at den-edge, as either side uses them: write yours, wait for theirs, give up together. */
function relay(sid: string, fetchImpl: typeof fetch, wait: (ms: number) => Promise<void>) {
  const session = `/pair/${sid}`;
  const call = (path: string, init?: RequestInit) => fetchImpl(path, init).catch(() => null);
  const send = (path: string, method: string, body: unknown) =>
    call(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return {
    call,
    send,
    put: async (slot: string, m: Uint8Array) => (await send(`${session}/${slot}`, 'PUT', { m: toBase64url(m) }))?.ok ?? false,
    /** The slot's message once the other side writes it; null when the session ends or the ten minutes run out. */
    read: async (slot: string): Promise<Bytes | null> => {
      for (let waited = 0; waited < SESSION_MS; waited += POLL_MS) {
        const res = await call(`${session}/${slot}`);
        if (res?.status === 200) {
          const m = ((await res.json().catch(() => null)) as { m?: unknown } | null)?.m;
          return typeof m === 'string' ? fromBase64url(m) : null;
        }
        if (res && res.status !== 202) return null;
        await wait(POLL_MS);
      }
      return null;
    },
    end: () => call(session, { method: 'DELETE' }),
  };
}

export async function join(code: string, options: JoinOptions = {}): Promise<JoinResult> {
  const { fetchImpl = fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = options;
  const parsed = parseCode(code);
  if (!parsed) return { error: 'mistyped' };
  if (!secureContext()) return { error: 'insecure' };
  const call = (path: string, init?: RequestInit) => fetchImpl(path, init).catch(() => null);
  const send = (path: string, method: string, body: unknown) =>
    call(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const opened = await send('/pair/open', 'POST', { nameplate: parsed.nameplate });
  if (!opened) return { error: 'unreachable' };
  if (opened.status !== 200) return { error: OPEN_ERRORS[opened.status] ?? 'unreachable' };
  const sid = ((await opened.json().catch(() => null)) as { sid?: unknown } | null)?.sid;
  if (typeof sid !== 'string' || !/^[0-9a-f]{32}$/.test(sid)) return { error: 'unreachable' };

  const { put, read, end } = relay(sid, fetchImpl, wait);
  const fail = async (): Promise<JoinResult> => {
    await end();
    return { error: 'failed' };
  };

  const label = cleanLabel(options.label ?? deviceLabel()) || 'Browser';
  const { state, a } = await joinerStart(parsed.secret, fromHex(sid), label, options.y);
  if (!(await put('a', a))) return fail();
  const b = await read('b');
  const finished = b && (await joinerFinish(state, b));
  if (!finished || !(await put('c', finished.c))) return fail();
  const d = await read('d');
  const handover = d && (await openHandover(finished.handoverKey, d));
  if (!handover) return fail();
  return { handover, inboxKey: (await linkKeys(handover.linkKey)).inbox };
}

// --- Hosting a pairing, as the TV does ---

export type HostError = 'unreachable' | 'busy' | 'failed' | 'insecure';
export type HostResult = { joiner: string } | { error: HostError };

export interface HostOptions {
  /** The library to hand over: this browser's, raw. */
  libraryKey: Bytes;
  /** What the joined device will call this one; this browser by default. */
  label?: string;
  /** The code to show, as soon as den-edge has minted its half of it. */
  onCode: (code: string) => void;
  /** Allow the device this names? It is the label that device sent, and only a device that ran the code right
      gets this far. A false ends the pairing. */
  allow: (joiner: string) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
  /** Fixed for tests. */
  sid?: string;
  secret?: string;
  linkKey?: Bytes;
  y?: Bytes;
}

const randomSecret = (): string =>
  [...crypto.getRandomValues(new Uint8Array(8))].map((b) => ALPHABET[b & 31]).join('');

const randomSid = (): string =>
  [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Host a pairing, so another browser joins this one's library without the TV: mint a session, show its code, run
 * CPace through the relay, ask before handing anything over, and seal the handover to the key only the device
 * that ran the same code can derive. The secret half of the code never reaches den-edge.
 */
export async function host(options: HostOptions): Promise<HostResult> {
  const { fetchImpl = fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = options;
  if (!secureContext()) return { error: 'insecure' };
  const sid = options.sid ?? randomSid();
  const secret = options.secret ?? randomSecret();
  const { send, put, read, end } = relay(sid, fetchImpl, wait);

  const made = await send('/pair/new', 'POST', { sid });
  if (!made) return { error: 'unreachable' };
  if (made.status !== 200) return { error: made.status === 429 || made.status === 503 ? 'busy' : 'unreachable' };
  const nameplate = ((await made.json().catch(() => null)) as { nameplate?: unknown } | null)?.nameplate;
  if (typeof nameplate !== 'string' || !parseCode(nameplate + secret)) return { error: 'unreachable' };
  options.onCode(nameplate + secret);

  const fail = async (): Promise<HostResult> => {
    await end();
    return { error: 'failed' };
  };
  const label = cleanLabel(options.label ?? deviceLabel()) || 'Browser';
  const a = await read('a');
  const responded = a && (await hostRespond(secret, fromHex(sid), label, a, options.y));
  if (!responded || !(await put('b', responded.b))) return fail();
  const c = await read('c');
  if (!c || !(await hostConfirm(responded.state, c))) return fail();
  if (!(await options.allow(responded.state.joiner))) return fail();
  const handover = {
    host: label,
    linkKey: options.linkKey ?? crypto.getRandomValues(new Uint8Array(32)),
    libraryKey: options.libraryKey,
  };
  const sealed = await sealHandover(responded.state.handoverKey, handover);
  if (!(await put('d', sealed))) return fail();
  return { joiner: responded.state.joiner };
}
