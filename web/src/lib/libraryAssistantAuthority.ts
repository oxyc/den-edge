// Assistant writes inside the library service (den-spec wire/assistant-v1.md §5–§6): the library's three assistant
// settings rows, read and written here and nowhere else, and den-core's `assistant_*` ops, which make every
// decision. An accepted request is performed as the library command a person's tap sends, so den-core's delivery
// and the removals latch treat it exactly as that tap.

import { hex } from './crypto';
import type { LibraryAuthorityCommandResult, LibrarySelectionScope } from './libraryServiceCore';
import type { AssistantApplied, LibraryCommand, TitleRef } from './libraryServiceProtocol';
import { syncPolicy } from './syncCore';
import type { ConfigValue, SettingsRow } from './wire';

export const DROPBOX_ROW = 'assistant';
export const GRANTS_ROW = 'assistant-grants';
export const APPLIED_ROW = 'assistant-applied';

/** Every op a grant made here allows, and the requests a day it may make (assistant v1 §5: 1–1000). */
const OPS = ['rate', 'seen', 'watchlist_add', 'watchlist_remove'] as const;
const DAILY_CAP = 100;
/** Pruning the applied row runs at most once a day (§5). */
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;

export interface DropboxKey {
  kid: string;
  public: string;
}

/** What the library service lends this authority: its rows, its commands, and den-edge. */
export interface AssistantPort {
  readonly libraryId: string;
  settings(name: string): SettingsRow | undefined;
  /** Read the library log to its head. */
  refresh(): Promise<void>;
  /** A person's command, as their tap sends it. `operationId` makes a repeated apply the same tracker event. */
  command(command: LibraryCommand, operationId: string): Promise<LibraryAuthorityCommandResult>;
  /** A series' aired regular episodes of `season`, from TMDB's shape; null while it cannot be had. */
  seasonEpisodes(title: TitleRef, season: number): Promise<number[] | null>;
  /** Load a series' shape, as the title page does before a whole-series Seen. False while it cannot be had. */
  loadShape(title: TitleRef): Promise<boolean>;
  /** Write settings into a row, with a fresh stamp; resolves once den-edge has them, or throws. */
  patch(
    name: string,
    changes: Record<string, ConfigValue | null>,
  ): Promise<LibrarySelectionScope[]>;
  /** Write a row whole, as compare-and-set (pruning: no tombstones). */
  replace(row: SettingsRow): Promise<void>;
  /** Hand den-edge the library's drop-box public key, with the member's proof. */
  putDropbox(key: DropboxKey): Promise<boolean>;
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
  setting: string;
  value: ConfigValue;
};

export const randomHex = (): string => hex(crypto.getRandomValues(new Uint8Array(32)));

export class LibraryAssistantAuthority {
  #pruneAt = 0;

  constructor(private readonly port: AssistantPort) {}

  #row(name: string): SettingsRow | null {
    return this.port.settings(name) ?? null;
  }

  dropbox(): DropboxKey | null {
    return syncPolicy<DropboxKey | null>({
      op: 'assistant_dropbox',
      assistant: this.#row(DROPBOX_ROW),
    });
  }

  /**
   * §1's consent step: the library's drop-box key (made, written, and given to den-edge when it has none), then a
   * grant key and its row. The grant's key is returned for den-edge's approval and is kept nowhere.
   */
  async consent(client: string): Promise<{ grant: string; key: string }> {
    await this.port.refresh();
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

  /** Mark a grant revoked (sticky, the earlier time kept). Absent when the library holds no such grant. */
  async revoke(grant: string): Promise<'revoked' | 'absent'> {
    await this.port.refresh();
    const value = this.#row(GRANTS_ROW)?.values[grant]?.value;
    if (!value) return 'absent';
    const revoked = syncPolicy<{ value: ConfigValue }>({
      op: 'assistant_revoke',
      grant,
      value,
      now: this.port.now(),
    });
    await this.port.patch(GRANTS_ROW, { [grant]: revoked.value });
    return 'revoked';
  }

  /**
   * §6 *Draining*: each request in `seq` order, opened and checked against the rows as they stand, the accepted ones
   * performed and recorded. A refusal is handled too, so acknowledged; a request that could not be performed or
   * recorded stops the drain there, unacknowledged, to be delivered again.
   */
  async apply(messages: ReadonlyArray<{ seq: number; sealed: string }>): Promise<{
    results: AssistantApplied[];
    ack: number | null;
    dropbox: DropboxKey | null;
    affected: LibrarySelectionScope[];
  }> {
    await this.port.refresh();
    const results: AssistantApplied[] = [];
    const affected: LibrarySelectionScope[] = [];
    let ack: number | null = null;
    for (const { seq, sealed } of [...messages].sort((a, b) => a.seq - b.seq)) {
      const opened = syncPolicy<{ accept: Accept } | { reject: string }>({
        op: 'assistant_open',
        library: this.port.libraryId,
        sealed,
        assistant: this.#row(DROPBOX_ROW),
        grants: this.#row(GRANTS_ROW),
        applied: this.#row(APPLIED_ROW),
        now: this.port.now(),
      });
      if ('reject' in opened) {
        results.push({ seq, outcome: 'rejected', reason: opened.reject });
        ack = seq;
        continue;
      }
      const accept = opened.accept;
      try {
        affected.push(...(await this.#perform(accept)));
        affected.push(...(await this.port.patch(APPLIED_ROW, { [accept.setting]: accept.value })));
      } catch (error) {
        console.warn('den: an assistant request could not be applied yet', error);
        break;
      }
      results.push({
        seq,
        outcome: 'accepted',
        op: accept.op,
        title: { type: accept.args.title.type, id: accept.args.title.id },
        detail: describe(accept),
      });
      ack = seq;
    }
    await this.#prune();
    return { results, ack, dropbox: this.dropbox(), affected };
  }

  async #perform(accept: Accept): Promise<LibrarySelectionScope[]> {
    const { title, value, season, episode } = accept.args;
    const operationId = `assistant:${accept.id}`;
    const run = async (command: LibraryCommand) =>
      (await this.port.command(command, operationId)).affected;
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
              ...(
                await this.port.command(
                  {
                    kind: 'episode-watched.set',
                    episode: { type: 'tv', id: title.id, season, episode: number },
                    watched,
                  },
                  `${operationId}:${number}`,
                )
              ).affected,
            );
          return scopes;
        }
        if (title.type === 'tv' && !(await this.port.loadShape(title)))
          throw new Error('the series’ episodes could not be loaded');
        return run({ kind: 'watched.set', title, watched });
      }
    }
  }

  /** Drop applied entries no request can be refused by any more, at most once a day. */
  async #prune(): Promise<void> {
    const now = this.port.now();
    if (now < this.#pruneAt) return;
    this.#pruneAt = now + PRUNE_EVERY_MS;
    const row = this.#row(APPLIED_ROW);
    if (!row) return;
    const { remove } = syncPolicy<{ remove: string[] }>({
      op: 'assistant_prune',
      applied: row,
      now,
    });
    if (!remove.length) return;
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
