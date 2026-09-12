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
  enc: CryptoKey;
  mac: CryptoKey;
}

export async function deriveKeys(libraryKey: Uint8Array<ArrayBuffer>): Promise<LibraryKeys> {
  const [id, enc, mac, token] = await Promise.all([
    hkdf(libraryKey, 'den/library/salt/v1', 'den/library/id/v1', 16),
    hkdf(libraryKey, 'den/library/v2', 'enc', 32),
    hkdf(libraryKey, 'den/library/v2', 'mac', 32),
    hkdf(libraryKey, 'den/library/v2', 'token', 32),
  ]);
  return {
    id: hex(id),
    token: hex(token),
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

export type Row = TitleRow | EpisodeRow | SettingsRow;

/** The name a row's key is the HMAC of. */
export function rowName(row: Row): string {
  if (row.kind === 'set') return `set:${row.name}`;
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

/** A row as den-edge stores it: `k` names the record, `v` is its sealed JSON. */
export async function seal(
  keys: LibraryKeys,
  row: Row,
  nonce: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(12)),
): Promise<{ k: string; v: string }> {
  const mac = await rowMac(keys, rowName(row));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: mac, tagLength: 128 },
    keys.enc,
    utf8.encode(JSON.stringify(row)),
  );
  const out = new Uint8Array(nonce.length + sealed.byteLength);
  out.set(nonce);
  out.set(new Uint8Array(sealed), nonce.length);
  return { k: hex(mac), v: toBase64url(out) };
}

/** Open a stored row; rejects one that was tampered with, sealed under another key, or moved to another `k`. */
export async function open(keys: LibraryKeys, k: string, v: string): Promise<Row> {
  const bytes = fromBase64url(v);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: fromHex(k), tagLength: 128 },
    keys.enc,
    bytes.slice(12),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plain)) as { kind?: unknown };
  if (parsed.kind !== 'rec' && parsed.kind !== 'ep' && parsed.kind !== 'set') {
    throw new Error(`unknown row kind ${String(parsed.kind)}`);
  }
  const row = parsed as Row;
  if (hex(await rowMac(keys, rowName(row))) !== k)
    throw new Error('the row names a different record than its key');
  return row;
}

/** The newest stamp in a row. */
export function newest(row: Row): Stamp {
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

export function fromHex(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(text.match(/../g) ?? [], (byte) => parseInt(byte, 16));
}

export function toBase64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  );
}
