// The library wire format, v2 (den-spec, wire/library-v2.md): the keys a library key derives, the encrypted
// rows den-edge's record log stores, hybrid-logical-clock stamps, and the merge every client runs. wire.test.ts
// checks it against den-spec's vectors, which the TV checks itself against too.

import { hex, hkdf } from './crypto';
import { syncPolicy } from './syncCore';

const utf8 = new TextEncoder();

/** Unix ms, a counter, and the issuing device's id. */
export type Stamp = [t: number, c: number, d: string];
/** Older than any real edit: a watched bit learned without a time. */
export const ZERO_STAMP: Stamp = [0, 0, ''];

export function compareStamps(a: Stamp, b: Stamp): number {
  return a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
}

/** Issues stamps later than every stamp this device has issued or seen, however its clock drifts. */
export class Clock {
  constructor(
    private readonly device: string,
    private last: Stamp = ZERO_STAMP,
  ) {}

  issue(now = Date.now()): Stamp {
    this.last = syncPolicy<Stamp>({ op: 'issue', last: this.last, now, device: this.device });
    return this.last;
  }

  see(stamp: Stamp) {
    if (compareStamps(stamp, this.last) > 0) this.last = stamp;
  }

  /** The last stamp issued or seen — what a device keeps between visits. */
  get current(): Stamp {
    return this.last;
  }
}

export interface LibraryKeys {
  /** The `{id}` in `/lib/{id}/…`. */
  id: string;
  /** The `x-den-library-token` header. */
  token: string;
  /** Membership proof for same-origin relayed household services. */
  member: string;
  enc: CryptoKey;
  mac: CryptoKey;
}

export async function deriveKeys(libraryKey: Uint8Array<ArrayBuffer>): Promise<LibraryKeys> {
  const [id, enc, mac, token, member] = await Promise.all([
    hkdf(libraryKey, 'den/library/salt/v1', 'den/library/id/v1', 16),
    hkdf(libraryKey, 'den/library/v2', 'enc', 32),
    hkdf(libraryKey, 'den/library/v2', 'mac', 32),
    hkdf(libraryKey, 'den/library/v2', 'token', 32),
    hkdf(libraryKey, 'den/library/v2', 'member', 32),
  ]);
  return {
    id: hex(id),
    token: hex(token),
    member: hex(member),
    enc: await crypto.subtle.importKey('raw', enc, 'AES-GCM', false, ['encrypt', 'decrypt']),
    mac: await crypto.subtle.importKey('raw', mac, { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]),
  };
}

type MediaType = 'movie' | 'tv';
type Status = 'none' | 'watchlist' | 'inProgress' | 'watched';
type Reaction = 'seen' | 'dislike' | 'like' | 'love';

export interface Stamped<T> {
  value: T;
  at: Stamp;
}

/** A resume point: the fraction, the viewing it belongs to, and the absolute position when known. */
export interface Progress {
  value: number;
  at: Stamp;
  viewing: number;
  seconds?: number;
}

export interface TitleRow {
  kind: 'rec';
  schema: number;
  title: { type: MediaType; id: number };
  status: Stamped<Status>;
  resume: Progress;
  reaction: Stamped<Reaction | null>;
  deleted: Stamped<boolean>;
  dismissed: Stamped<boolean>;
  episodesReset: Stamp | null;
  addedAt: number;
  watchedAt: number | null;
  [unknown: string]: unknown;
}

export interface EpisodeRow {
  kind: 'ep';
  schema: number;
  title: { type: MediaType; id: number };
  season: number;
  episode: number;
  progress: Progress;
  [unknown: string]: unknown;
}

/** A setting's value, tagged as the TV's ConfigValue encodes it. */
export type ConfigValue =
  | { bool: boolean }
  | { int: number }
  | { string: string }
  | { ints: number[] }
  | { strings: string[] };

/** A group of settings, `set:<name>`: each setting its own stamped value, null a cleared one. */
export interface SettingsRow {
  kind: 'set';
  schema: number;
  name: string;
  values: Record<string, Stamped<ConfigValue | null>>;
  [unknown: string]: unknown;
}

export interface WatchRegister {
  imported: boolean;
  progress?: Progress;
  plays: Record<string, number>;
  cleared: [number, Stamp] | null;
  [unknown: string]: unknown;
}

/** Thirty-two episode registers (or a film's register 0), `wat:<type>:<id>:<season>:<block>`. */
export interface WatchRow {
  kind: 'wat';
  schema: 3;
  title: { type: MediaType; id: number };
  season: number;
  block: number;
  seasonReset: Stamp | null;
  entries: Record<string, WatchRegister>;
  [unknown: string]: unknown;
}

/** Provider settlement entries. Their tuple shape is interpreted only by den-core. */
export interface ReceiptRow {
  kind: 'snt';
  schema: 3;
  provider: string;
  account: string;
  target: string;
  entries: Record<string, unknown>;
  [unknown: string]: unknown;
}

/**
 * A library v4 document (den-spec wire/library-v4.md §3): a title, a season of a series, or one tracker account's
 * receipts for either. Read, merged, written and named only by den-core; the fields are its business.
 */
export interface DocumentRow {
  kind: 'title' | 'season' | 'delivery';
  format: number;
  title: { type: MediaType; id: number };
  season?: number;
  provider?: string;
  account?: string;
  [unknown: string]: unknown;
}

export type Row = TitleRow | EpisodeRow | SettingsRow | WatchRow | ReceiptRow | DocumentRow;

export const isDocument = (row: Row): row is DocumentRow =>
  row.kind === 'title' || row.kind === 'season' || row.kind === 'delivery';

/** The name a row's key is the HMAC of. */
export function rowName(row: Row): string {
  if (isDocument(row)) return syncPolicy<string>({ op: 'doc_name', document: row });
  if (row.kind === 'set') return `set:${row.name}`;
  if (row.kind === 'wat') return `wat:${row.title.type}:${row.title.id}:${row.season}:${row.block}`;
  if (row.kind === 'snt') {
    if (row.target.startsWith('wat:')) return `snt:${row.provider}:${row.account}:${row.target}`;
    return syncPolicy<string>({
      op: 'receipt_name',
      provider: row.provider,
      account: row.account,
      target: row.target,
    });
  }
  const title = `${row.title.type}:${row.title.id}`;
  return row.kind === 'rec' ? `rec:${title}` : `ep:${title}:${row.season}:${row.episode}`;
}

/** How far ahead of this device's clock a stamp may be before it isn't believed (den-spec §4). */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * The row with every stamp more than a day ahead of `now` read as the zero stamp. A wrong clock, or a key holder
 * writing year 2100, would otherwise win every merge for good; this way the value wins nothing, the clock never sees
 * it, and the next write of the row replaces it.
 */
export function believe<T extends Row>(row: T, now = Date.now()): T {
  const fix = (stamp: Stamp): Stamp => (stamp[0] > now + FUTURE_TOLERANCE_MS ? ZERO_STAMP : stamp);
  const fixed = <V>(s: Stamped<V>): Stamped<V> => ({ ...s, at: fix(s.at) });
  // den-core reads a document's stamps the same way wherever it derives state from one (§5).
  if (row.kind === 'wat' || row.kind === 'snt' || isDocument(row)) return row;
  if (row.kind === 'ep') return { ...row, progress: { ...row.progress, at: fix(row.progress.at) } };
  if (row.kind === 'set') {
    return {
      ...row,
      values: Object.fromEntries(
        Object.entries(row.values).map(([key, value]) => [key, fixed(value)]),
      ),
    };
  }
  return {
    ...row,
    status: fixed(row.status),
    resume: { ...row.resume, at: fix(row.resume.at) },
    reaction: fixed(row.reaction),
    deleted: fixed(row.deleted),
    dismissed: fixed(row.dismissed),
    episodesReset: row.episodesReset && fix(row.episodesReset),
  };
}

async function rowMac(keys: LibraryKeys, name: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', keys.mac, utf8.encode(name)));
}

/**
 * A row as den-edge stores it: `k` names the record, `v` is its sealed JSON — or, for a v4 document, den-core's
 * compressed encoding of it (§4), at the cap a merge may use. A write that must fit the smaller cap of a new write
 * encodes it itself (`encodeDocument`) and seals that.
 */
export async function seal(
  keys: LibraryKeys,
  row: Row,
  nonce: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(12)),
): Promise<{ k: string; v: string }> {
  if (isDocument(row)) {
    const encoded = encodeDocument(row, false);
    if (!encoded) throw new Error(`den: ${rowName(row)} is too large to store`);
    return sealPlaintext(keys, encoded.name, encoded.plaintext, nonce);
  }
  return sealPlaintext(keys, rowName(row), utf8.encode(JSON.stringify(row)), nonce);
}

/** `plaintext` sealed as the row `name`. */
export async function sealPlaintext(
  keys: LibraryKeys,
  name: string,
  plaintext: Uint8Array<ArrayBuffer>,
  nonce: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(12)),
): Promise<{ k: string; v: string }> {
  const mac = await rowMac(keys, name);
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: mac, tagLength: 128 },
    keys.enc,
    plaintext,
  );
  const out = new Uint8Array(nonce.length + sealed.byteLength);
  out.set(nonce);
  out.set(new Uint8Array(sealed), nonce.length);
  return { k: hex(mac), v: toBase64url(out) };
}

/**
 * A document's plaintext (`doc_encode`), or null when it is over the cap: 224 KiB sealed for a new write (`write`),
 * 256 KiB for a merge, a write-back or a receipt (§4 *Size*).
 */
export function encodeDocument(
  document: DocumentRow,
  write: boolean,
): { name: string; plaintext: Uint8Array<ArrayBuffer> } | null {
  const encoded = syncPolicy<{ name: string; plaintext: string } | { too_large: true }>({
    op: 'doc_encode',
    document,
    write,
  });
  if ('too_large' in encoded) return null;
  return { name: encoded.name, plaintext: fromBase64url(encoded.plaintext) };
}

/**
 * What a stored row is, as a reader of library v4 tells (§4): a row it reads (`newer` when a later format holds it,
 * read for the fields this build knows and never written); a row of a kind it doesn't know, or of a framing newer
 * than it knows, kept unread; or a row that can't be attributed to a name at all, with the reason.
 */
export type Opened =
  | { row: Row; newer?: true; dropped?: unknown[] }
  | { unknown: Record<string, unknown> }
  | { newerFraming: true }
  | { unreadable: string; json?: Record<string, unknown> };

const LEGACY_KINDS = new Set(['rec', 'ep', 'set', 'wat', 'snt']);

export async function openEntry(keys: LibraryKeys, k: string, v: string): Promise<Opened> {
  let plain: Uint8Array<ArrayBuffer>;
  try {
    const bytes = fromBase64url(v);
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: fromHex(k), tagLength: 128 },
        keys.enc,
        bytes.slice(12),
      ),
    );
  } catch {
    return { unreadable: 'open' };
  }
  const named = async (name: string | null | undefined) =>
    !!name && hex(await rowMac(keys, name)) === k;
  if (plain[0] === 0x7b) {
    let parsed: { kind?: unknown };
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)) as {
        kind?: unknown;
      };
    } catch {
      return { unreadable: 'invalid_json' };
    }
    if (typeof parsed.kind === 'string' && LEGACY_KINDS.has(parsed.kind)) {
      const row = parsed as Row;
      if (!(await named(rowName(row)))) return { unreadable: 'identity' };
      // Not read as state (den-core refuses an episode of a film), but its JSON is what the switch is given, as the
      // TV gives it, so whichever client switches stages the same rows.
      return wellFormed(row) ? { row } : { unreadable: 'episode_of_film', json: parsed };
    }
  }
  const decoded = syncPolicy<{
    status: 'document' | 'newer' | 'row' | 'unreadable';
    reason?: string;
    name?: string | null;
    document?: DocumentRow;
    row?: Record<string, unknown>;
    dropped?: unknown[];
  }>({ op: 'doc_decode', plaintext: toBase64url(plain) });
  if (decoded.status === 'unreadable') return { unreadable: decoded.reason ?? 'unreadable' };
  if (decoded.status === 'newer' && !decoded.document) return { newerFraming: true };
  if (decoded.status === 'row') return { unknown: decoded.row ?? {} };
  if (!(await named(decoded.name))) return { unreadable: 'identity' };
  if (decoded.dropped?.length)
    console.warn(`den: ${decoded.name} read without its malformed parts`, decoded.dropped);
  return decoded.status === 'newer'
    ? { row: decoded.document!, newer: true }
    : { row: decoded.document!, dropped: decoded.dropped };
}

/**
 * Only a series has episodes (library v2 §3). den-core refuses any other episode row, so one held anywhere would
 * stop every page that asks it about the library; such a row is left out wherever rows are read.
 */
export const wellFormed = (row: Row): boolean => row.kind !== 'ep' || row.title?.type === 'tv';

/** Open a stored row; rejects one that was tampered with, sealed under another key, moved to another `k`, or that
 * this build does not read. */
export async function open(keys: LibraryKeys, k: string, v: string): Promise<Row> {
  const opened = await openEntry(keys, k, v);
  if ('row' in opened) return opened.row;
  throw new Error(
    'unreadable' in opened
      ? `an unreadable row (${opened.unreadable})`
      : 'unknown' in opened
        ? `unknown row kind ${String(opened.unknown.kind)}`
        : 'a row of a newer framing',
  );
}

/** The newest stamp in a row. */
export function newest(row: Row): Stamp {
  if (isDocument(row)) return documentNewest(row);
  if (row.kind === 'wat' || row.kind === 'snt') return syncPolicy<Stamp>({ op: 'newest', row });
  const stamps =
    row.kind === 'ep'
      ? [row.progress.at]
      : row.kind === 'set'
        ? Object.values(row.values).map((v) => v.at)
        : [
            row.status.at,
            row.resume.at,
            row.reaction.at,
            row.deleted.at,
            row.dismissed.at,
            row.episodesReset ?? ZERO_STAMP,
          ];
  return stamps.reduce((a, b) => (compareStamps(b, a) > 0 ? b : a), ZERO_STAMP);
}

/**
 * The newest stamp anywhere in a document, so this device's next stamp is issued after every one it has read. A
 * stamp more than a day ahead is left out, as `believe` reads one.
 */
function documentNewest(document: DocumentRow, now = Date.now()): Stamp {
  let latest = ZERO_STAMP;
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      Number.isInteger(value[0]) &&
      Number.isInteger(value[1]) &&
      typeof value[2] === 'string'
    ) {
      const stamp = value as Stamp;
      if (stamp[0] <= now + FUTURE_TOLERANCE_MS && compareStamps(stamp, latest) > 0) latest = stamp;
      return;
    }
    for (const inner of Object.values(value)) visit(inner);
  };
  visit(document);
  return latest;
}

export function mergeTitle(a: TitleRow, b: TitleRow): TitleRow {
  return syncPolicy<TitleRow>({ op: 'merge', a, b });
}

export function mergeEpisode(a: EpisodeRow, b: EpisodeRow): EpisodeRow {
  return syncPolicy<EpisodeRow>({ op: 'merge', a, b });
}

/** Per setting, the later stamp; a setting only one version has is kept. */
export function mergeSettings(a: SettingsRow, b: SettingsRow): SettingsRow {
  return syncPolicy<SettingsRow>({ op: 'merge', a, b });
}

export function mergeV3<T extends WatchRow | ReceiptRow>(a: T, b: T): T {
  return syncPolicy<T>({ op: 'merge', a, b });
}

/** Two versions of one v4 document (§6, §9). */
export function mergeDocument(a: DocumentRow, b: DocumentRow): DocumentRow {
  return syncPolicy<DocumentRow>({ op: 'doc_merge', a, b });
}

export function fromHex(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(text.match(/../g) ?? [], (byte) => parseInt(byte, 16));
}

export function toBase64url(bytes: Uint8Array): string {
  // In slices: a v4 value reaches 256 KiB, past what one spread call takes as arguments.
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  );
}
