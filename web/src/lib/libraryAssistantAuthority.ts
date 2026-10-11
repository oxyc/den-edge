// Assistant writes inside the library service (den-spec wire/assistant-v1.md §5–§6, §10): the library's three
// assistant settings rows, read and written here and nowhere else, this device's own records of revocations and
// applied requests, and den-core's `assistant_*` ops, which make every decision. An accepted request is performed as
// the library command a person's tap sends, stamped at the request's own time, so den-core's delivery, the removals
// latch and `apply_write`'s replay rule treat it exactly as that tap made then.

import { hex } from './crypto';
import type { LibraryAuthorityCommandResult, LibrarySelectionScope } from './libraryServiceCore';
import type {
  AssistantApplied,
  AssistantGrantView,
  LibraryCommand,
  TitleRef,
} from './libraryServiceProtocol';
import { syncPolicy } from './syncCore';
import type { ConfigValue, Row, SettingsRow, Stamp } from './wire';

export const DROPBOX_ROW = 'assistant';
export const GRANTS_ROW = 'assistant-grants';
export const APPLIED_ROW = 'assistant-applied';
/** Read records (§15): each connection that may read, by its grant id, with its read key. */
export const READ_ROW = 'assistant-read';

/** §15 *Publishing*: a changed projection waits this long for the library to settle; an unchanged one is sent again
 * this often, so its `at` stays fresh. */
const PUBLISH_DEBOUNCE_MS = 30_000;
const HEARTBEAT_MS = 15 * 60_000;

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
 * neither for this device. `renewedAt`: when grants were last renewed (§5, at most daily).
 */
export interface AssistantRecords {
  revoked: string[];
  applied: Record<string, ConfigValue>;
  renewedAt: number;
}

const EMPTY: AssistantRecords = { revoked: [], applied: {}, renewedAt: 0 };

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
  /** Replace a grant's projection at den-edge with one publish's set and sealed parts, or drop it, with the member's
   * proof. */
  putProjection(grant: string, set: string, parts: string[]): Promise<boolean>;
  deleteProjection(grant: string): Promise<boolean>;
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
  };
}

/**
 * §10: what a key reset copies of the assistant rows into the new library. Not the drop-box keys — the device it
 * shuts out knew them — and every grant and read record revoked at `now`, so Settings still shows which assistants
 * were connected and none of their keys works. The applied row goes as it is. `revoked`: their grant ids, for the
 * device's own record.
 */
export function resetAssistantRows(rows: Row[], now: number): { rows: Row[]; revoked: string[] } {
  const revoked: string[] = [];
  const out: Row[] = [];
  for (const row of rows) {
    if (row.kind === 'set' && row.name === DROPBOX_ROW) continue;
    if (row.kind !== 'set' || (row.name !== GRANTS_ROW && row.name !== READ_ROW)) {
      out.push(row);
      continue;
    }
    const values: SettingsRow['values'] = {};
    for (const [grant, setting] of Object.entries(row.values)) {
      revoked.push(grant);
      try {
        const { value } = syncPolicy<{ value: ConfigValue }>({
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

  #row(name: string): SettingsRow | null {
    return this.port.settings(name) ?? null;
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
      const next = {
        revoked,
        applied,
        renewedAt: Math.max(held.renewedAt, update.renewedAt ?? 0),
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

  dropbox(): DropboxKey | null {
    return syncPolicy<DropboxKey | null>({
      op: 'assistant_dropbox',
      assistant: this.#row(DROPBOX_ROW),
    });
  }

  /**
   * Every grant and read record the library's rows hold, for Settings; any shown revoked joins this device's revoked
   * set.
   */
  async grants(): Promise<{ grants: AssistantGrantView[]; reads: AssistantGrantView[] }> {
    const records = await this.#load();
    const listed = syncPolicy<{ grants: AssistantGrantView[]; reads: AssistantGrantView[] }>({
      op: 'assistant_grants',
      grants: this.#row(GRANTS_ROW),
      read: this.#row(READ_ROW),
      localRevoked: records.revoked,
      now: this.port.now(),
    });
    const revoked = [...listed.grants, ...listed.reads]
      .filter((g) => g.state === 'revoked')
      .map((g) => g.grant);
    if (revoked.some((id) => !records.revoked.includes(id))) await this.#remember({ revoked });
    return listed;
  }

  /**
   * §1's and §15's consent step. To write: the library's drop-box key (made, written, and given to den-edge when it
   * has none), then a grant key and its row. To read only: a grant key with no grants row setting, so it can never
   * write. To read: its read key, recorded in the read row. The keys are returned for den-edge's approval and are
   * kept nowhere else.
   */
  async consent(
    client: string,
    { write, read }: { write: boolean; read: boolean },
  ): Promise<{ grant: string; key: string; readKey?: string }> {
    if (!write && !read) throw new Error('a consent allows writing, reading, or both');
    await this.port.refresh();
    const { grant, key } = write
      ? await this.#writeGrant(client)
      : (() => {
          const made = syncPolicy<{ grant: string; secret: string }>({
            op: 'assistant_grant_key',
            random: this.port.random(),
          });
          return { grant: made.grant, key: made.secret };
        })();
    if (!read) return { grant, key };
    const record = syncPolicy<{ key: string; setting: string; value: ConfigValue }>({
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
      const made = syncPolicy<DropboxKey & { setting: string; value: ConfigValue }>({
        op: 'assistant_keygen_dropbox',
        random: this.port.random(),
      });
      // Written first: den-edge is given the public half only once every device can open what is sealed to it.
      await this.port.patch(DROPBOX_ROW, { [made.setting]: made.value });
      dropbox = this.dropbox();
    }
    if (!dropbox || !(await this.port.putDropbox(dropbox)))
      throw new Error('den-edge did not take the library’s drop-box key');
    const grant = syncPolicy<{
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
      now: this.port.now(),
    });
    // Before den-edge approves: no request can reach a device before its grant.
    await this.port.patch(GRANTS_ROW, { [grant.setting]: grant.value });
    return { grant: grant.grant, key: grant.secret };
  }

  /**
   * Revoke a grant and its read record, whatever their state (sticky, the earlier time kept), and add it to this
   * device's revoked set first, so this device refuses it whether or not the rows' writes land. Absent when the
   * library holds neither.
   */
  async revoke(grant: string): Promise<'revoked' | 'absent'> {
    await this.#remember({ revoked: [grant] });
    await this.port.refresh();
    let found = false;
    for (const name of [GRANTS_ROW, READ_ROW]) {
      const value = this.#row(name)?.values[grant]?.value;
      if (!value) continue;
      found = true;
      const revoked = syncPolicy<{ value: ConfigValue }>({
        op: 'assistant_revoke',
        grant,
        value,
        now: this.port.now(),
      });
      await this.port.patch(name, { [grant]: revoked.value });
    }
    // Its projection goes at once; the next publish deletes it again should this not land.
    if (found && this.#row(READ_ROW)?.values[grant]) void this.port.deleteProjection(grant);
    return found ? 'revoked' : 'absent';
  }

  /**
   * §5 *Renewal*: the grants whose connection den-edge still lists, kept from expiring — at most once a day. A grant
   * that is not a v1 grant, or that the row no longer holds, is left as it is. How many were renewed.
   */
  async renew(grants: readonly string[]): Promise<number> {
    const now = this.port.now();
    if (now - (await this.#load()).renewedAt < DAY_MS) return 0;
    await this.port.refresh();
    let renewed = 0;
    // A grant and its read record are renewed together (§15).
    for (const name of [GRANTS_ROW, READ_ROW]) {
      const row = this.#row(name);
      const changes: Record<string, ConfigValue> = {};
      for (const grant of grants) {
        const value = row?.values[grant]?.value;
        if (!value) continue;
        try {
          const next = syncPolicy<{ value: ConfigValue }>({
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

  /** What was last sent for each grant: its digest and when, so a changed one waits, and an unchanged one heartbeats. */
  #published = new Map<string, { digest: string; at: number }>();
  /** The digest the library first read as, and when: a change is sent once it has stood `PUBLISH_DEBOUNCE_MS`. */
  #pending: { digest: string; since: number } | null = null;
  /** Grants whose projection den-edge was asked to drop, so each is asked once (and again if it comes back). */
  #deleted = new Set<string>();

  /**
   * §15 *Publishing*: build the projection for every live read grant and send it when the lists changed (once they
   * have stood for 30 s) or 15 minutes have passed; ask den-edge once to drop every dead grant's. Nothing to do,
   * and nothing built, for a library with no read records. Which grants were sent.
   */
  async publish(): Promise<string[]> {
    const read = this.#row(READ_ROW);
    if (!read || !Object.keys(read.values).length) return [];
    const now = this.port.now();
    const records = await this.#load();
    let built: ProjectionAnswer;
    try {
      built = syncPolicy<ProjectionAnswer>({
        op: 'assistant_projection',
        library: this.port.libraryId,
        documents: this.port.documents(),
        layouts: this.port.layouts(),
        head: this.port.head(),
        read,
        grants: this.#row(GRANTS_ROW),
        localRevoked: records.revoked,
        random: this.port.random(),
        now,
      });
    } catch (error) {
      // §15: a library past 64 parts is never published cut short. It stays unpublished until it is smaller.
      if (!(error instanceof Error) || !error.message.endsWith(': too_large')) throw error;
      console.error('den: the library is too large to publish for assistants', error);
      return [];
    }
    if (this.#pending?.digest !== built.digest)
      this.#pending = { digest: built.digest, since: now };
    const settled = now - this.#pending.since >= PUBLISH_DEBOUNCE_MS;
    const sent: string[] = [];
    for (const entry of built.publish) {
      this.#deleted.delete(entry.grant);
      const last = this.#published.get(entry.grant);
      const changed = last?.digest !== built.digest;
      const due = !last || (changed && settled) || now - last.at >= HEARTBEAT_MS;
      if (!due) continue;
      if (await this.port.putProjection(entry.grant, entry.set, entry.parts)) {
        this.#published.set(entry.grant, { digest: built.digest, at: now });
        sent.push(entry.grant);
      }
    }
    for (const grant of built.delete) {
      if (this.#deleted.has(grant)) continue;
      if (await this.port.deleteProjection(grant)) {
        this.#deleted.add(grant);
        this.#published.delete(grant);
      }
    }
    return sent;
  }

  #open(sealed: string, records: AssistantRecords): Opened {
    return syncPolicy<Opened>({
      op: 'assistant_open',
      library: this.port.libraryId,
      device: this.port.device,
      sealed,
      assistant: this.#row(DROPBOX_ROW),
      grants: this.#row(GRANTS_ROW),
      applied: this.#row(APPLIED_ROW),
      localRevoked: records.revoked,
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
   */
  async apply(messages: ReadonlyArray<{ seq: number; sealed: string }>): Promise<{
    results: AssistantApplied[];
    ack: number | null;
    dropbox: DropboxKey | null;
    affected: LibrarySelectionScope[];
  }> {
    await this.port.refresh();
    // Revocations in the row as read join this device's set before anything is opened against it.
    await this.grants();
    let records = await this.#load();
    const order = messages
      .map((message) => {
        const opened = this.#open(message.sealed, records);
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
      const opened = this.#open(sealed, records);
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
      dropbox: this.dropbox(),
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
    const { remove } = syncPolicy<{ remove: string[] }>({
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
