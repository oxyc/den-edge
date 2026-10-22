// Assistant writes inside the library service (den-spec wire/assistant-v1.md §5–§6, §10): the library's three
// assistant settings rows, read and written here and nowhere else, this device's own records of revocations and
// applied requests, and den-core's `assistant_*` ops, which make every decision. An accepted request is performed as
// the library command a person's tap sends, stamped at the request's own time, so den-core's delivery, the removals
// latch and `apply_write`'s replay rule treat it exactly as that tap made then.

import { hex } from './crypto';
import type { LibraryAuthorityCommandResult, LibrarySelectionScope } from './libraryServiceCore';
import type {
  AssistantApplied,
  AssistantConnection,
  AssistantGrantView,
  AssistantNeeds,
  LibraryCommand,
  TitleRef,
} from './libraryServiceProtocol';
import { assistantPolicy, ensureAssistantPolicy } from './assistantCore';
import { buildProjection } from './assistantProjection';
import { policyAnswer } from './syncCore';
import type { ConfigValue, Row, SettingsRow, Stamp } from './wire';

export const DROPBOX_ROW = 'assistant';
export const GRANTS_ROW = 'assistant-grants';
export const APPLIED_ROW = 'assistant-applied';
/** Read records (§15): each connection that may read, by its grant id, with its read key. */
export const READ_ROW = 'assistant-read';
/** Play records (§16): each connection that may play on the TV, by its grant id. Only a TV applies a play. */
export const PLAY_ROW = 'assistant-play';
/** The rows a grant's id keys, renewed and revoked together. */
const GRANT_ROWS = [GRANTS_ROW, READ_ROW, PLAY_ROW] as const;
/** The connection rows: whole household rows once a household is split into profiles (profiles-v1 §6.1). */
export const CONNECTION_ROWS = [DROPBOX_ROW, ...GRANT_ROWS] as const;
/** The household's preferences, whose hide rules a projection carries (§15). */
const PREFS_ROW = 'prefs';

/** `assistant_grants`' answer: the grants, read records and play records, each with its state. */
export interface AssistantGrantList {
  grants: AssistantGrantView[];
  reads: AssistantGrantView[];
  plays: AssistantGrantView[];
}

/** §15 *Publishing*: a changed projection waits this long for the library to settle; an unchanged one is sent again
 * this often, so its `at` stays fresh. */
const PUBLISH_DEBOUNCE_MS = 30_000;
const HEARTBEAT_MS = 15 * 60_000;
/**
 * The least time between two sends of one grant's changed projection from this device. Every device of a household
 * publishes, and den-edge takes 60 an hour per grant from all of them together (§15), while a library that changes
 * every minute — a TV saving playback progress, which Continue Watching carries — would otherwise be sent every
 * minute by each.
 */
const MIN_INTERVAL_MS = 5 * 60_000;

/** Every op a grant made here allows, and the requests a day it may make (§5: 1–1000). */
const OPS = ['rate', 'seen', 'watchlist_add', 'watchlist_remove'] as const;
const DAILY_CAP = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DropboxKey {
  kid: string;
  public: string;
}

/**
 * This device's own records (§6): every grant it has seen revoked, and every applied entry it recorded or read, by
 * request id. Kept durably and only ever grown (pruned with the row), so an older row den-edge serves later can undo
 * neither for this device. `renewedAt`: when grants were last renewed (§5, at most daily). `dropped`: read grants
 * whose projection den-edge has dropped at this device's asking (§15), so it is asked once.
 */
export interface AssistantRecords {
  revoked: string[];
  applied: Record<string, ConfigValue>;
  renewedAt: number;
  dropped: string[];
  /** What this device last published (§15), so a page opened later neither builds nor sends it again. */
  publication?: Publication;
}

/**
 * The last projection build: `key`, a digest of everything it was built from; `dueAt`, when it must be built again
 * with those inputs unchanged; `sent`, each grant's digest and when it was sent; `layouts`, the series layouts known,
 * which a page that has not seen those series yet builds with too.
 */
export interface Publication {
  key: string;
  dueAt: number;
  sent: Record<string, { digest: string; at: number }>;
  layouts: Record<string, SeriesLayout>;
}

const EMPTY: AssistantRecords = { revoked: [], applied: {}, renewedAt: 0, dropped: [] };

/** A read record in these states has its projection dropped (§15); `newer` is left to a client that reads it. */
const DEAD = new Set(['revoked', 'expired', 'malformed']);

/** Under what this device keeps its records, sealed, beside the library (`LibraryLog.keep`). */
export const ASSISTANT_RECORDS = 'assistant.records.v1';

/** What the library service lends this authority: its rows, its commands, its device's records, and den-edge. */
export interface AssistantPort {
  readonly libraryId: string;
  /** This device's stamp device id (16 hex). */
  readonly device: string;
  settings(name: string): SettingsRow | undefined;
  /** Read the library log to its head. */
  refresh(): Promise<void>;
  /**
   * A person's command, as their tap sends it, its writes stamped `stamp`. `operationId` makes a repeated apply the
   * same tracker event.
   */
  command(
    command: LibraryCommand,
    operationId: string,
    stamp: Stamp,
  ): Promise<LibraryAuthorityCommandResult>;
  /** A series' aired regular episodes of `season`, from TMDB's shape; null while it cannot be had. */
  seasonEpisodes(title: TitleRef, season: number): Promise<number[] | null>;
  /** Load a series' shape, as the title page does before a whole-series Seen. False while it cannot be had. */
  loadShape(title: TitleRef): Promise<boolean>;
  /** Write settings into a row, with a fresh stamp; resolves once den-edge has them, or throws. */
  patch(
    name: string,
    changes: Record<string, ConfigValue | null>,
  ): Promise<LibrarySelectionScope[]>;
  /**
   * Run `work`, writing `changes` into the row `name` in the same `/lib` batch as the edit it makes (or straight
   * after, when it makes none); throws when either could not be kept.
   */
  ride<T>(name: string, changes: Record<string, ConfigValue>, work: () => Promise<T>): Promise<T>;
  /** Write a row whole, as compare-and-set (pruning: no tombstones). */
  replace(row: SettingsRow): Promise<void>;
  /** Hand den-edge the library's drop-box public key, with the member's proof. */
  putDropbox(key: DropboxKey): Promise<boolean>;
  /** The library's v4 documents as held, the series layouts known (by TMDB id), and the log head they were read at. */
  documents(): unknown[];
  layouts(): Record<string, SeriesLayout>;
  head(): number;
  /** Changes whenever anything a projection is built from may have: the log head or a series layout known. */
  inputs(): string;
  /** Replace a grant's projection at den-edge with one publish's set and sealed parts, or drop it, with the member's
   * proof: this library's, or `member` (a lent household connection's). A refusal that said how long to wait
   * (`429` with `Retry-After`) answers that wait. */
  putProjection(
    grant: string,
    set: string,
    parts: string[],
    member?: AssistantConnection['member'],
  ): Promise<boolean | { retryAfterMs: number }>;
  deleteProjection(grant: string, member?: AssistantConnection['member']): Promise<boolean>;
  /** This library's member proof, or null while den-edge does not know it as a member. */
  membership(): Promise<AssistantConnection['member'] | null>;
  loadRecords(): Promise<AssistantRecords | null | undefined>;
  saveRecords(records: AssistantRecords): Promise<void>;
  now(): number;
  /** 32 bytes from the platform's CSPRNG, as hex. */
  random(): string;
}

type Accept = {
  grant: string;
  id: string;
  at: number;
  op: (typeof OPS)[number];
  args: {
    title: TitleRef;
    value?: boolean | 'dislike' | 'like' | 'love' | null;
    season?: number;
    episode?: number;
  };
  stamp: Stamp;
  setting: string;
  value: ConfigValue;
};

type Opened = { accept: Accept } | { reject: string };

/** A series' season layout as den-core's Continue Watching takes it (§15). */
export interface SeriesLayout {
  seasons: Array<{ season: number; episodes: number }>;
  last_aired: { season: number; episode: number } | null;
}

/** `assistant_projection`'s answer: each publish is one set id and its sealed parts, sent as they are. */
interface ProjectionAnswer {
  publish: Array<{ grant: string; set: string; parts: string[] }>;
  delete: string[];
  digest: string;
}

export const randomHex = (): string => hex(crypto.getRandomValues(new Uint8Array(32)));

/** A record read back as it was written, or empty when there is none or it does not read. */
function readRecords(value: AssistantRecords | null | undefined): AssistantRecords {
  if (!value || typeof value !== 'object') return { ...EMPTY };
  return {
    revoked: Array.isArray(value.revoked)
      ? value.revoked.filter((id) => typeof id === 'string')
      : [],
    applied:
      value.applied && typeof value.applied === 'object' && !Array.isArray(value.applied)
        ? value.applied
        : {},
    renewedAt: typeof value.renewedAt === 'number' ? value.renewedAt : 0,
    dropped: Array.isArray(value.dropped)
      ? value.dropped.filter((id) => typeof id === 'string')
      : [],
    ...(readPublication(value.publication) ? { publication: value.publication } : {}),
  };
}

/** The drop-box key `row` (`DROPBOX_ROW`) holds, once the assistant module is loaded (`ensureAssistantPolicy`). */
export const dropboxKey = (row: SettingsRow | null): DropboxKey | null =>
  assistantPolicy<DropboxKey | null>({ op: 'assistant_dropbox', assistant: row });

/**
 * When this device's last publication must next be built, its inputs unchanged (`Publication.dueAt`); null when it
 * has none. Before then, a page that has written nothing has nothing to publish: another device publishes its own
 * changes, and this device's go through the library log, which publishes them.
 */
export const publicationDueAt = (records: AssistantRecords | null | undefined): number | null =>
  readRecords(records).publication?.dueAt ?? null;

function readPublication(value: unknown): value is Publication {
  if (!value || typeof value !== 'object') return false;
  const { key, dueAt, sent, layouts } = value as Partial<Publication>;
  return (
    typeof key === 'string' &&
    typeof dueAt === 'number' &&
    !!sent &&
    typeof sent === 'object' &&
    Object.values(sent).every(
      (entry) => typeof entry?.digest === 'string' && typeof entry.at === 'number',
    ) &&
    !!layouts &&
    typeof layouts === 'object'
  );
}

/** A grants or read row with each record's `expiresAt` left out: what a renewal changes, and nothing else. */
function withoutExpiry(row: SettingsRow | null): unknown {
  if (!row) return null;
  return Object.fromEntries(
    Object.entries(row.values).map(([grant, { value, at }]) => {
      if (!value || !('string' in value) || typeof value.string !== 'string')
        return [grant, { value, at }];
      try {
        const { expiresAt: _, ...record } = JSON.parse(value.string) as Record<string, unknown>;
        return [grant, record];
      } catch {
        return [grant, { value, at }];
      }
    }),
  );
}

/** SHA-256 of `text`, as hex. */
async function digestText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

/**
 * §10: what a key reset copies of the assistant rows into the new library. Not the drop-box keys — the device it
 * shuts out knew them — and every grant, read and play record revoked at `now`, so Settings still shows which
 * assistants were connected and none of their keys works. The applied row goes as it is. `revoked`: their grant ids,
 * for the device's own record. The assistant module is loaded only for a library that has any of them.
 */
export async function resetAssistantRows(
  rows: Row[],
  now: number,
): Promise<{ rows: Row[]; revoked: string[] }> {
  const keyed = (row: Row): row is SettingsRow =>
    row.kind === 'set' && (GRANT_ROWS as readonly string[]).includes(row.name);
  if (rows.some((row) => keyed(row) && Object.keys(row.values).length))
    await ensureAssistantPolicy();
  const revoked: string[] = [];
  const out: Row[] = [];
  for (const row of rows) {
    if (row.kind === 'set' && row.name === DROPBOX_ROW) continue;
    if (!keyed(row)) {
      out.push(row);
      continue;
    }
    const values: SettingsRow['values'] = {};
    for (const [grant, setting] of Object.entries(row.values)) {
      revoked.push(grant);
      try {
        const { value } = assistantPolicy<{ value: ConfigValue }>({
          op: 'assistant_revoke',
          grant,
          value: setting.value,
          now,
        });
        values[grant] = { ...setting, value };
      } catch {
        // Not a JSON object: no grant, and nothing to revoke; it is still in the device's revoked set.
        values[grant] = setting;
      }
    }
    out.push({ ...row, values });
  }
  return { rows: out, revoked: [...new Set(revoked)] };
}

export class LibraryAssistantAuthority {
  #pruneAt = 0;
  /** Serialises this device's record updates: each one reads, joins and writes. */
  #records: Promise<unknown> = Promise.resolve();

  constructor(private readonly port: AssistantPort) {}

  /**
   * A row of this library's, or, for a connection row, the lent household's when there is one: Owner's service then
   * builds and applies with the household's connection, and with its own documents, prefs and applied row.
   */
  #row(name: string, lent: AssistantConnection | null = null): SettingsRow | null {
    if (lent && (CONNECTION_ROWS as readonly string[]).includes(name))
      return (lent.rows.find((row) => row.name === name) as SettingsRow | undefined) ?? null;
    return this.port.settings(name) ?? null;
  }

  /** The grants this device knows revoked: its own records', and a lent household's. */
  #revoked(records: AssistantRecords, lent: AssistantConnection | null): string[] {
    return lent ? [...new Set([...records.revoked, ...lent.revoked])].sort() : records.revoked;
  }

  /**
   * This library's connection, to lend Owner's library service on a household split into profiles: read to the log's
   * head, with every revocation its rows show joined to this device's records first. Null while den-edge does not
   * know this library as a member.
   */
  async lend(): Promise<AssistantConnection | null> {
    if (__DEN_TV_LEGACY_JS_CORE__) return null;
    await this.port.refresh();
    if (CONNECTION_ROWS.some((name) => Object.keys(this.#row(name)?.values ?? {}).length))
      await this.grants();
    const member = await this.port.membership();
    if (!member) return null;
    const rows = CONNECTION_ROWS.flatMap((name) => {
      const row = this.#row(name);
      return row
        ? [{ kind: row.kind, schema: row.schema, name: row.name, values: row.values }]
        : [];
    });
    return { member, rows, revoked: (await this.#load()).revoked };
  }

  async #load(): Promise<AssistantRecords> {
    try {
      return readRecords(await this.port.loadRecords());
    } catch (error) {
      console.warn('den: this device’s assistant records could not be read', error);
      return { ...EMPTY };
    }
  }

  /** Join `update` into the stored records: sets only grow (pruning aside), `renewedAt` only moves on. */
  #remember(update: Partial<AssistantRecords> & { prune?: string[] }): Promise<AssistantRecords> {
    const run = this.#records.then(async () => {
      const held = await this.#load();
      const revoked = [...new Set([...held.revoked, ...(update.revoked ?? [])])].sort();
      const applied = { ...held.applied, ...(update.applied ?? {}) };
      for (const id of update.prune ?? []) delete applied[id];
      // The last publication is replaced whole: it is what was last built and sent, not a set that grows.
      const publication = update.publication ?? held.publication;
      const next: AssistantRecords = {
        revoked,
        applied,
        renewedAt: Math.max(held.renewedAt, update.renewedAt ?? 0),
        dropped: [...new Set([...held.dropped, ...(update.dropped ?? [])])].sort(),
        ...(publication ? { publication } : {}),
      };
      // Losing a record weakens this device against an older row; it is said, never silent.
      await this.port.saveRecords(next).catch((error: unknown) => {
        console.error('den: this device’s assistant records could not be saved', error);
      });
      return next;
    });
    this.#records = run.catch(() => undefined);
    return run;
  }

  /** Once the assistant module is loaded (`ensureAssistantPolicy`). */
  dropbox(lent: AssistantConnection | null = null): DropboxKey | null {
    return dropboxKey(this.#row(DROPBOX_ROW, lent));
  }

  #list(records: AssistantRecords, lent: AssistantConnection | null = null): AssistantGrantList {
    return assistantPolicy<AssistantGrantList>({
      op: 'assistant_grants',
      grants: this.#row(GRANTS_ROW, lent),
      read: this.#row(READ_ROW, lent),
      play: this.#row(PLAY_ROW, lent),
      localRevoked: this.#revoked(records, lent),
      now: this.port.now(),
    });
  }

  /**
   * Every grant, read and play record the library's rows hold (or a lent household's), for Settings; any shown
   * revoked joins this device's revoked set.
   */
  async grants(lent: AssistantConnection | null = null): Promise<AssistantGrantList> {
    await ensureAssistantPolicy();
    const records = await this.#load();
    const listed = this.#list(records, lent);
    const revoked = [...listed.grants, ...listed.reads, ...listed.plays]
      .filter((g) => g.state === 'revoked')
      .map((g) => g.grant);
    if (revoked.some((id) => !records.revoked.includes(id))) await this.#remember({ revoked });
    return listed;
  }

  /**
   * §1's, §15's and §16's consent step. To write: the library's drop-box key (made, written, and given to den-edge
   * when it has none), then a grant key and its row, and a play record, so it may also play on the TV. To read only: a
   * grant key with no grants row setting, so it can never write. To read: its read key, recorded in the read row. The
   * keys are returned for den-edge's approval and are kept nowhere else.
   */
  async consent(
    client: string,
    { write, read }: { write: boolean; read: boolean },
  ): Promise<{ grant: string; key: string; readKey?: string }> {
    if (!write && !read) throw new Error('a consent allows writing, reading, or both');
    await ensureAssistantPolicy();
    await this.port.refresh();
    const { grant, key } = write
      ? await this.#writeGrant(client)
      : (() => {
          const made = assistantPolicy<{ grant: string; secret: string }>({
            op: 'assistant_grant_key',
            random: this.port.random(),
          });
          return { grant: made.grant, key: made.secret };
        })();
    if (!read) return { grant, key };
    const record = assistantPolicy<{ key: string; setting: string; value: ConfigValue }>({
      op: 'assistant_keygen_read',
      grant,
      random: this.port.random(),
      client,
      now: this.port.now(),
    });
    // Before den-edge approves, as a grant is: nothing reads under a key the library does not record.
    await this.port.patch(READ_ROW, { [record.setting]: record.value });
    return { grant, key, readKey: record.key };
  }

  async #writeGrant(client: string): Promise<{ grant: string; key: string }> {
    let dropbox = this.dropbox();
    if (!dropbox) {
      const made = assistantPolicy<DropboxKey & { setting: string; value: ConfigValue }>({
        op: 'assistant_keygen_dropbox',
        random: this.port.random(),
      });
      // Written first: den-edge is given the public half only once every device can open what is sealed to it.
      await this.port.patch(DROPBOX_ROW, { [made.setting]: made.value });
      dropbox = this.dropbox();
    }
    if (!dropbox || !(await this.port.putDropbox(dropbox)))
      throw new Error('den-edge did not take the library’s drop-box key');
    const now = this.port.now();
    const grant = assistantPolicy<{
      grant: string;
      secret: string;
      setting: string;
      value: ConfigValue;
    }>({
      op: 'assistant_keygen_grant',
      random: this.port.random(),
      client,
      ops: [...OPS],
      cap: DAILY_CAP,
      now,
    });
    // §16: changing the library and playing on the TV are one consent; the play record has a row of its own, since
    // a grant listing a TV op would be no grant to a client from before play.
    const play = assistantPolicy<{ setting: string; value: ConfigValue }>({
      op: 'assistant_keygen_play',
      grant: grant.grant,
      client,
      now,
    });
    // Before den-edge approves: no request can reach a device before its grant.
    await this.port.patch(GRANTS_ROW, { [grant.setting]: grant.value });
    await this.port.patch(PLAY_ROW, { [play.setting]: play.value });
    return { grant: grant.grant, key: grant.secret };
  }

  /**
   * Revoke a grant and its read and play records, whatever their state (sticky, the earlier time kept), and add it to
   * this device's revoked set first, so this device refuses it whether or not the rows' writes land. Absent when the
   * library holds none of them.
   */
  async revoke(grant: string): Promise<'revoked' | 'absent'> {
    await this.#remember({ revoked: [grant] });
    await ensureAssistantPolicy();
    await this.port.refresh();
    let found = false;
    for (const name of GRANT_ROWS) {
      const value = this.#row(name)?.values[grant]?.value;
      if (!value) continue;
      found = true;
      const revoked = assistantPolicy<{ value: ConfigValue }>({
        op: 'assistant_revoke',
        grant,
        value,
        now: this.port.now(),
      });
      await this.port.patch(name, { [grant]: revoked.value });
    }
    // Its projection goes at once; asked again whenever the library is read should this not land.
    if (found && this.#row(READ_ROW)?.values[grant]) void this.#drop(grant);
    return found ? 'revoked' : 'absent';
  }

  /**
   * §5 *Renewal*: the grants whose connection den-edge still lists, kept from expiring — at most once a day. A grant
   * that is not a v1 grant, or that the row no longer holds, is left as it is. How many were renewed.
   */
  async renew(grants: readonly string[]): Promise<number> {
    const now = this.port.now();
    if (now - (await this.#load()).renewedAt < DAY_MS) return 0;
    await ensureAssistantPolicy();
    await this.port.refresh();
    let renewed = 0;
    // A grant and its read and play records are renewed together (§15, §16).
    for (const name of GRANT_ROWS) {
      const row = this.#row(name);
      const changes: Record<string, ConfigValue> = {};
      for (const grant of grants) {
        const value = row?.values[grant]?.value;
        if (!value) continue;
        try {
          const next = assistantPolicy<{ value: ConfigValue }>({
            op: 'assistant_renew',
            grant,
            value,
            now,
          });
          if (JSON.stringify(next.value) !== JSON.stringify(value)) changes[grant] = next.value;
        } catch {
          // No v1 grant or read record under that id: nothing to renew.
        }
      }
      if (Object.keys(changes).length) await this.port.patch(name, changes);
      renewed += Object.keys(changes).length;
    }
    await this.#remember({ renewedAt: now });
    return renewed;
  }

  /**
   * What an open page owes assistants: draining for a live grant to write, publishing for a live read record. A
   * library with neither row answers at once, with no den-core call and no assistant module loaded. A read record no
   * longer live has its projection dropped at den-edge here, once by this device, so that is done even when nothing
   * publishes any more. A play record asks nothing of Den Web: only a TV plays.
   */
  async needs(): Promise<AssistantNeeds> {
    if (__DEN_TV_LEGACY_JS_CORE__) return { write: false, read: false };
    const grants = this.#row(GRANTS_ROW);
    const read = this.#row(READ_ROW);
    if (!Object.keys(grants?.values ?? {}).length && !Object.keys(read?.values ?? {}).length)
      return { write: false, read: false };
    await ensureAssistantPolicy();
    const records = await this.#load();
    const listed = this.#list(records);
    const live = (list: AssistantGrantView[]) => list.some((g) => g.state === 'active');
    const dead = listed.reads.flatMap((g) =>
      DEAD.has(g.state) && !records.dropped.includes(g.grant) ? [g.grant] : [],
    );
    for (const grant of dead) void this.#drop(grant);
    return { write: live(listed.grants), read: live(listed.reads) };
  }

  /** Ask den-edge to drop a grant's projection; once it has, this device never asks again. */
  async #drop(grant: string, lent: AssistantConnection | null = null): Promise<void> {
    if (this.#dropping.has(grant)) return;
    this.#dropping.add(grant);
    try {
      if (await this.port.deleteProjection(grant, lent?.member))
        await this.#remember({ dropped: [grant] });
    } finally {
      this.#dropping.delete(grant);
    }
  }

  /** What was last sent for each grant: its digest and when, so a changed one waits, and an unchanged one heartbeats. */
  #published = new Map<string, { digest: string; at: number }>();
  /** The digest the library first read as, and when: a change is sent once it has stood `PUBLISH_DEBOUNCE_MS`. */
  #pending: { digest: string; since: number } | null = null;
  #dropping = new Set<string>();
  /** When den-edge said each grant's next send may come (`Retry-After`), or a failed send is tried again. */
  #retryAt = new Map<string, number>();
  /** The projection's inputs at the last build, and when a build is next due with the inputs unchanged. */
  #builtFrom: string | null = null;
  #dueAt = 0;
  /**
   * Before this time no grant of the last build may be sent, whatever changes (`MIN_INTERVAL_MS`, `Retry-After`), so
   * nothing is built; `#holdRead` is the read row it holds for, since a grant connected since is sent at once.
   */
  #holdUntil = 0;
  #holdRead: string | null = null;
  /** Whether `#published` has been read back from this device's records (`Publication.sent`). */
  #restored = false;
  /** Whether this service has said the projection was up to date when it was opened. */
  #saidCurrent = false;

  /**
   * §15 *Publishing*: build the projection for every live read grant and send it when the lists changed (once they
   * have stood for 30 s, and no sooner than `MIN_INTERVAL_MS` after its last send) or 15 minutes have passed, never
   * before a refusal's `Retry-After`; ask den-edge once to drop every dead grant's. A projection is
   * rebuilt only when its inputs changed or something is due, so a quiet library's tick builds nothing; and nothing is
   * built at all for a library with no read records. Which grants were sent.
   *
   * What was last built and sent is kept on this device (`Publication`), so a page opened again with the library as it
   * was builds nothing until the heartbeat is due: a build reads the whole library, and on a phone it holds the library
   * Worker for seconds.
   *
   * `lent`: a split household's connection (§15): its library id, read and grants rows and revoked set, and its member
   * proof to send with, around this library's lists, prefs and head.
   *
   * The library service runs it beside its other requests, not before them (`LibraryServiceCore`), and the build is
   * done in a Worker of its own (`buildProjection`). One publish at a time: a tick that finds one under way sends
   * nothing.
   */
  async publish(lent: AssistantConnection | null = null): Promise<string[]> {
    if (this.#publishing) return [];
    this.#publishing = true;
    try {
      return await this.#publish(lent);
    } finally {
      this.#publishing = false;
    }
  }

  #publishing = false;

  async #publish(lent: AssistantConnection | null): Promise<string[]> {
    const read = this.#row(READ_ROW, lent);
    if (!read || !Object.keys(read.values).length) return [];
    const now = this.port.now();
    const readKey = JSON.stringify(withoutExpiry(read));
    if (now < this.#holdUntil && readKey === this.#holdRead) return [];
    // A change in either log is a change of the inputs.
    const inputs = lent
      ? `${this.port.inputs()}:${JSON.stringify([lent.member.libraryId, lent.rows, lent.revoked])}`
      : this.port.inputs();
    if (inputs === this.#builtFrom && now < this.#dueAt) return [];
    const records = await this.#load();
    const kept = records.publication;
    if (!this.#restored) {
      this.#restored = true;
      for (const [grant, sent] of Object.entries(kept?.sent ?? {}))
        if (!this.#published.has(grant)) this.#published.set(grant, sent);
    }
    // The layouts known when it was last built, under the ones this page has learnt since.
    const layouts = { ...kept?.layouts, ...this.port.layouts() };
    const library = lent?.member.libraryId ?? this.port.libraryId;
    const grants = this.#row(GRANTS_ROW, lent);
    // The household's hide rules travel with the lists (§15); a change to them is a change of the rows.
    const prefs = this.#row(PREFS_ROW);
    const localRevoked = this.#revoked(records, lent);
    // The library as it stands now, written once: the inputs' digest and the build's request share it, and later
    // changes to the rows cannot reach a build already on its way.
    const documents = JSON.stringify(this.port.documents());
    const known = JSON.stringify(layouts);
    // Not the log's head, which every write moves, nor the clock: what the lists are made of. Nor a grant's expiry,
    // which only its daily renewal moves: whether it is live is den-core's to decide when it is next built, and the
    // heartbeat builds at least every 15 minutes.
    const rows = JSON.stringify([
      withoutExpiry(read),
      withoutExpiry(grants),
      prefs,
      localRevoked,
    ]).slice(1, -1);
    const key = await digestText(`[${JSON.stringify(library)},${documents},${known},${rows}]`);
    if (kept?.key === key && now < kept.dueAt) {
      this.#builtFrom = inputs;
      this.#dueAt = kept.dueAt;
      // Said once a page: that a page opened on the library as it was published did not build it again.
      if (!this.#saidCurrent) console.info('den: assistant projection up to date');
      this.#saidCurrent = true;
      return [];
    }
    const request = JSON.stringify({
      op: 'assistant_projection',
      library,
      head: this.port.head(),
      read,
      grants,
      prefs,
      localRevoked,
      random: this.port.random(),
      now,
    });
    const started = performance.now();
    let buildMs: number;
    let built: ProjectionAnswer;
    try {
      built = policyAnswer<ProjectionAnswer>(
        await buildProjection(
          `${request.slice(0, -1)},"documents":${documents},"layouts":${known}}`,
        ),
      );
      buildMs = Math.round(performance.now() - started);
    } catch (error) {
      // §15: a library past 64 parts is never published cut short. It stays unpublished until it is smaller.
      if (!(error instanceof Error) || !error.message.endsWith(': too_large')) throw error;
      console.error('den: the library is too large to publish for assistants', error);
      // Not tried again until the library changes, or the heartbeat comes round.
      this.#builtFrom = inputs;
      this.#dueAt = now + HEARTBEAT_MS;
      return [];
    }
    this.#builtFrom = inputs;
    if (this.#pending?.digest !== built.digest)
      this.#pending = { digest: built.digest, since: now };
    const settleAt = this.#pending.since + PUBLISH_DEBOUNCE_MS;
    /** When a grant is next sent: never sent, at once; changed, once the change has settled and `MIN_INTERVAL_MS`
     * has passed since its last send; else at its heartbeat — and never before den-edge said it may be. */
    const sendAt = (grant: string) => {
      const last = this.#published.get(grant);
      const wait = this.#retryAt.get(grant) ?? 0;
      if (!last) return Math.max(now, wait);
      if (last.digest !== built.digest) return Math.max(settleAt, last.at + MIN_INTERVAL_MS, wait);
      return Math.max(last.at + HEARTBEAT_MS, wait);
    };
    const sent: string[] = [];
    let dueAt = Infinity;
    let holdUntil = Infinity;
    for (const entry of built.publish) {
      if (now >= sendAt(entry.grant)) {
        const answer = await this.port.putProjection(
          entry.grant,
          entry.set,
          entry.parts,
          lent?.member,
        );
        if (answer === true) {
          this.#published.set(entry.grant, { digest: built.digest, at: now });
          this.#retryAt.delete(entry.grant);
          sent.push(entry.grant);
        } else {
          // Refused with a wait: that long. Failed otherwise: tried again once the next tick builds.
          this.#retryAt.set(
            entry.grant,
            now + (typeof answer === 'object' ? answer.retryAfterMs : PUBLISH_DEBOUNCE_MS),
          );
        }
      }
      dueAt = Math.min(dueAt, sendAt(entry.grant));
      const last = this.#published.get(entry.grant);
      holdUntil = Math.min(
        holdUntil,
        Math.max(last ? last.at + MIN_INTERVAL_MS : 0, this.#retryAt.get(entry.grant) ?? 0),
      );
    }
    // No live grant holds nothing back: the next change of the inputs builds.
    this.#holdUntil = Number.isFinite(holdUntil) ? holdUntil : 0;
    this.#holdRead = readKey;
    for (const grant of built.delete) {
      this.#published.delete(grant);
      if (!records.dropped.includes(grant)) await this.#drop(grant, lent);
    }
    this.#dueAt = dueAt;
    await this.#remember({
      publication: {
        key,
        // No live grant: nothing is due until the inputs change.
        dueAt: Number.isFinite(dueAt) ? dueAt : Number.MAX_SAFE_INTEGER,
        sent: Object.fromEntries(this.#published),
        layouts,
      },
    });
    // Once it is recorded: a page opened after this line neither builds nor sends it again.
    console.info(`den: assistant projection built in ${buildMs}ms, sent ${sent.length}`);
    return sent;
  }

  /**
   * Den Web drains only the library's queue: a play found there is refused (`wrong_queue`), never applied here. A
   * lent household's connection opens it (its library id, drop-box key, grants and play rows); what was applied is
   * always this library's own row.
   */
  #open(sealed: string, records: AssistantRecords, lent: AssistantConnection | null): Opened {
    return assistantPolicy<Opened>({
      op: 'assistant_open',
      library: lent?.member.libraryId ?? this.port.libraryId,
      device: this.port.device,
      sealed,
      queue: 'library',
      assistant: this.#row(DROPBOX_ROW, lent),
      grants: this.#row(GRANTS_ROW, lent),
      play: this.#row(PLAY_ROW, lent),
      applied: this.#row(APPLIED_ROW),
      localRevoked: this.#revoked(records, lent),
      localApplied: records.applied,
      now: this.port.now(),
    });
  }

  /**
   * §6 *Draining*, after reading the log to its head: the requests in the order they were made (by `at`; one that
   * does not open by `seq`), each opened and checked against the rows and this device's records as they stand, the
   * accepted ones performed and recorded. Every request handled is acknowledged, except `from_future`, which stays
   * queued until the clocks agree; a request that could not be performed or recorded stops the drain there, to be
   * delivered again.
   *
   * `lent`: a split household's connection, whose queue this is; each accepted request is performed on this
   * library, Owner's, which assistant activity targets (profiles-v1 §4), and recorded in its applied row.
   */
  async apply(
    messages: ReadonlyArray<{ seq: number; sealed: string }>,
    lent: AssistantConnection | null = null,
  ): Promise<{
    results: AssistantApplied[];
    ack: number | null;
    dropbox: DropboxKey | null;
    affected: LibrarySelectionScope[];
  }> {
    await ensureAssistantPolicy();
    await this.port.refresh();
    // Revocations in the row as read join this device's set before anything is opened against it.
    await this.grants(lent);
    let records = await this.#load();
    const order = messages
      .map((message) => {
        const opened = this.#open(message.sealed, records, lent);
        return { ...message, at: 'accept' in opened ? opened.accept.at : null };
      })
      // A refused request has no `at` to learn and changes nothing: those go first, by `seq`.
      .sort((a, b) => (a.at ?? -1) - (b.at ?? -1) || a.seq - b.seq);
    const results: AssistantApplied[] = [];
    const affected: LibrarySelectionScope[] = [];
    /** The lowest `seq` that may not be acknowledged: a `from_future`, or one that could not be applied. */
    let held = Infinity;
    for (const [index, { seq, sealed }] of order.entries()) {
      // Opened again: an earlier request in this drain may have changed what this one is checked against.
      const opened = this.#open(sealed, records, lent);
      if ('reject' in opened) {
        if (opened.reject === 'from_future') {
          held = Math.min(held, seq);
          // Loud: a clock more than five minutes off is a fault the household should see.
          console.error(
            'den: an assistant request is dated more than five minutes ahead of this device’s clock; it stays queued until the clocks agree',
          );
        }
        results.push({ seq, outcome: 'rejected', reason: opened.reject });
        continue;
      }
      const accept = opened.accept;
      try {
        // In this device's applied set before its batch is sent (§6 *Performing*).
        records = await this.#remember({ applied: { [accept.setting]: accept.value } });
        affected.push(
          ...(await this.port.ride(APPLIED_ROW, { [accept.setting]: accept.value }, () =>
            this.#perform(accept),
          )),
        );
      } catch (error) {
        console.warn('den: an assistant request could not be applied yet', error);
        // Nothing of it was kept, so this device must not refuse it as applied when it comes again.
        records = await this.#remember({ prune: [accept.setting] });
        // Neither it nor any request not reached yet is acknowledged: they are delivered again.
        held = Math.min(held, ...order.slice(index).map((m) => m.seq));
        break;
      }
      results.push({
        seq,
        outcome: 'accepted',
        op: accept.op,
        title: { type: accept.args.title.type, id: accept.args.title.id },
        detail: describe(accept),
      });
    }
    const handled = messages.map((m) => m.seq).filter((seq) => seq < held);
    await this.#prune(records);
    return {
      results,
      ack: handled.length ? Math.max(...handled) : null,
      dropbox: this.dropbox(lent),
      affected,
    };
  }

  async #perform(accept: Accept): Promise<LibrarySelectionScope[]> {
    const { title, value, season, episode } = accept.args;
    const operationId = `assistant:${accept.id}`;
    const run = async (command: LibraryCommand, id = operationId) =>
      (await this.port.command(command, id, accept.stamp)).affected;
    switch (accept.op) {
      case 'watchlist_add':
        return run({ kind: 'watchlist.add', title });
      case 'watchlist_remove':
        return run({ kind: 'library.remove', title });
      case 'rate':
        return run({
          kind: 'reaction.set',
          title,
          reaction: (value ?? null) as 'dislike' | 'like' | 'love' | null,
        });
      case 'seen': {
        const watched = value === true;
        if (episode !== undefined && season !== undefined)
          return run({
            kind: 'episode-watched.set',
            episode: { type: 'tv', id: title.id, season, episode },
            watched,
          });
        if (season !== undefined) {
          const episodes = await this.port.seasonEpisodes(title, season);
          if (!episodes) throw new Error('the season’s episodes could not be loaded');
          if (season > 0)
            return run({
              kind: 'season-watched.set',
              title: { type: 'tv', id: title.id },
              season,
              episodes,
              watched,
            });
          // Specials have no season-wide command: each is marked as its own Seen would be.
          const scopes: LibrarySelectionScope[] = [];
          for (const number of episodes)
            scopes.push(
              ...(await run(
                {
                  kind: 'episode-watched.set',
                  episode: { type: 'tv', id: title.id, season, episode: number },
                  watched,
                },
                `${operationId}:${number}`,
              )),
            );
          return scopes;
        }
        if (title.type === 'tv' && !(await this.port.loadShape(title)))
          throw new Error('the series’ episodes could not be loaded');
        return run({ kind: 'watched.set', title, watched });
      }
    }
  }

  /** Drop applied entries no request can be refused by any more, from the row and this device's record: daily. */
  async #prune(records: AssistantRecords): Promise<void> {
    const now = this.port.now();
    if (now < this.#pruneAt) return;
    this.#pruneAt = now + DAY_MS;
    const row = this.#row(APPLIED_ROW);
    const { remove } = assistantPolicy<{ remove: string[] }>({
      op: 'assistant_prune',
      applied: row,
      localApplied: records.applied,
      now,
    });
    if (!remove.length) return;
    await this.#remember({ prune: remove });
    if (!row || !remove.some((id) => id in row.values)) return;
    const values = { ...row.values };
    for (const id of remove) delete values[id];
    try {
      await this.port.replace({ ...row, values });
    } catch (error) {
      console.warn('den: applied assistant requests could not be pruned', error);
    }
  }
}

/** What an accepted request did, for the page's toast; `%s` is where the title's name goes. */
function describe({ op, args }: Accept): string {
  const where =
    args.episode !== undefined
      ? ` S${args.season} · E${args.episode} of`
      : args.season !== undefined
        ? ` season ${args.season} of`
        : '';
  switch (op) {
    case 'watchlist_add':
      return 'added %s to your watchlist';
    case 'watchlist_remove':
      return 'removed %s from your watchlist';
    case 'seen':
      return `marked${where} %s as ${args.value === true ? 'seen' : 'unseen'}`;
    case 'rate':
      return args.value === 'love'
        ? 'marked %s as Love'
        : args.value === 'like'
          ? 'marked %s as Like'
          : args.value === 'dislike'
            ? 'marked %s as Not for me'
            : 'cleared your rating of %s';
  }
}
