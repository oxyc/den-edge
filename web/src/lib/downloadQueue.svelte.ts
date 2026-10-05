import { SvelteMap } from 'svelte/reactivity';
import type { BrowserClock } from './clock';
import {
  contentKeyOf,
  downloadName,
  readDownload,
  readDownloads,
  releaseValue,
  removedRow,
  startRow,
  withValues,
  type Download,
  type DownloadHedge,
  type DownloadTitle,
  type StallClock,
} from './downloadRows';
import type { LibraryLog } from './log';
import { syncPolicy } from './syncCore';
import {
  answerOf,
  cancelSource,
  prepareSource,
  rankable,
  type Preparation,
  type SourceAnswer,
  type TitleSource,
} from './titleSources';
import { readSyncedPrefs } from '../settings/values';

/** How soon a download still preparing is asked about again. */
export const POLL_MS = 5_000;
/** The longest a job that has stopped changing waits between asks. */
export const POLL_MAX_MS = 60_000;

/**
 * The wait before the next status ask, after `quiet` asks in a row that changed nothing: POLL_MS while a download
 * moves, doubling to POLL_MAX_MS while it sits queued or stalled.
 */
export function pollDelay(quiet: number): number {
  return Math.min(POLL_MS * 2 ** Math.max(0, quiet), POLL_MAX_MS);
}

/** `download_status`'s answer (den-spec library-v4 §17). `state` is null for a lapsed ticket, which says nothing. */
export interface DownloadState {
  state:
    | 'starting'
    | 'fetching'
    | 'not_started'
    | 'refused'
    | 'paused'
    | 'unreachable'
    | 'ready'
    | 'no_working_release'
    | 'release_gone'
    | null;
  service?: string;
  until?: number;
  renew?: boolean;
  clock: StallClock;
  stalled: boolean;
  reannounce: boolean;
  write_progress: boolean;
  report: boolean;
  announce: boolean;
}

/** In flight: the debrid is fetching it, or it will be asked for again by itself. */
export const inFlight = (state: DownloadState['state']) =>
  state === 'starting' || state === 'fetching' || state === 'paused';

/** A fresh resolve of a download's content: scout's list, null when scout couldn't be reached. */
export type Resolve = (
  title: DownloadTitle,
) => Promise<{ sources: TitleSource[] | null; answer?: SourceAnswer }>;

export interface StartInput {
  title: DownloadTitle;
  source: TitleSource;
  /** The list it was picked from, counted as `candidates`. */
  sources?: TitleSource[];
}

const SAVE_FAILED = 'Couldn’t save that download to your library. Try again in a moment.';

/**
 * The library's downloads (`set:download:*`), seen from this browser: the rows are the queue, shared with every
 * device. What den-scout last said about each one is this tab's own (`answers`), as is the play ticket it asks with
 * (`urls`) — a ticket another device wrote may not be one this browser can reach.
 */
export class DownloadQueue {
  /** Moves when the rows may have changed: a write here, or a refresh of the library (`touch`). */
  revision = $state(0);
  /** What den-scout last said about each download, by row name. */
  readonly answers = new SvelteMap<string, Preparation>();
  /** What den-scout last said about an alternate being tried beside a partial primary. */
  readonly hedgeAnswers = new SvelteMap<string, Preparation>();
  /** The stall clock this browser has seen move, by row name: ahead of the row's, which is written coarsely. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Moves only with a new answer, which `answers` announces.
  readonly clocks = new Map<string, StallClock>();
  /** The play ticket this browser asks with, by row name: its own resolve's, never written unless it holds the lease. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Read by the polls, never by the page.
  readonly urls = new Map<string, string>();
  /** This browser's usable ticket for a persisted alternate. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Read by polls and winner handling, never by the page.
  readonly hedgeUrls = new Map<string, string>();
  /** Rows whose ticket den-scout said had lapsed, renewed here: the lease holder writes the fresh one back. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Read by the lease holder's pass, never by the page.
  readonly lapsed = new Set<string>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- In-flight deduplication is private bookkeeping.
  private pending = new Map<string, Promise<Preparation>>();
  private log: LibraryLog | null = null;
  private clock: BrowserClock | null = null;
  /** This page's own address for a ticket another device wrote (`scoutTicket`); null where it can't reach it. */
  private ticket: (url: string) => string | null = (url) =>
    url.startsWith('/scout/') ? url : null;
  /** Resolves a download's content again, for a ticket this browser can't use. */
  resolve: Resolve | null = null;

  constructor(
    private readonly prepare: (
      url: string,
      queue: boolean,
      prefetch: boolean,
    ) => Promise<Preparation> = (url, queue, prefetch) =>
      prepareSource(url, queue, undefined, prefetch),
    readonly cancelRelease: (url: string, reannounce: boolean) => Promise<boolean> = (
      url,
      reannounce,
    ) => cancelSource(url, reannounce),
  ) {}

  /** The library this browser has open, and its clock. `ticket` maps a row's URL to one this page can ask. */
  attach(
    log: LibraryLog | null,
    clock: BrowserClock,
    ticket?: (url: string) => string | null,
    resolve?: Resolve,
  ): void {
    if (this.log !== log) {
      this.answers.clear();
      this.hedgeAnswers.clear();
      this.clocks.clear();
      this.urls.clear();
      this.hedgeUrls.clear();
    }
    this.log = log;
    this.clock = clock;
    if (ticket) this.ticket = ticket;
    if (resolve) this.resolve = resolve;
    this.touch();
  }

  /** The library was read again, or written: what the rows say may have changed. */
  touch(): void {
    this.revision++;
  }

  get device(): string | undefined {
    return this.clock?.device;
  }

  get library(): LibraryLog | null {
    return this.log;
  }

  /** Every live download, newest first, with the seq each was read at. */
  list(): Download[] {
    void this.revision;
    const log = this.log;
    return log
      ? readDownloads(log.rows()).map((d) => ({ ...d, seq: log.seqOf(`set:${d.name}`) }))
      : [];
  }

  /** One title's downloads, in season and episode order. */
  forTitle(type: 'movie' | 'tv', id: number): Download[] {
    return this.list()
      .filter((d) => d.title.mediaType === type && d.title.mediaId === id)
      .sort(
        (a, b) =>
          (a.title.season ?? 0) - (b.title.season ?? 0) ||
          (a.title.episode ?? 0) - (b.title.episode ?? 0),
      );
  }

  /** The download of one title or episode, if one is live. */
  of(type: 'movie' | 'tv', id: number, season?: number, episode?: number): Download | undefined {
    void this.revision;
    const row = this.log?.settings(
      downloadName(contentKeyOf({ mediaType: type, mediaId: id, season, episode, title: '' })),
    );
    return row ? (readDownload(row) ?? undefined) : undefined;
  }

  /** What a download is doing, from its row and what den-scout last said. */
  status(download: Download, now = Date.now()): DownloadState {
    const answer = this.answers.get(download.name);
    const clock = this.clocks.get(download.name);
    const status = syncPolicy<DownloadState>({
      op: 'download_status',
      row: download.row,
      ...(answer ? { answer: answerOf(answer) } : {}),
      ...(clock ? { clock } : {}),
      now,
    });
    // A ticket that lapsed and could not be renewed: the release is no longer listed.
    if (status.state === null && answer?.message === GONE)
      return { ...status, state: 'release_gone' };
    return status;
  }

  /** The viewer's audio language, which the dub rule ranks against beside the title's own. */
  preferred(): string | undefined {
    return readSyncedPrefs(this.log?.settings('prefs')).audioLanguage;
  }

  /**
   * The release a download of `sources` starts with (den-core `rank_releases`' pick): the TV's first pick, cached
   * first, then the tiers Play uses, then the best picture.
   */
  pick(sources: TitleSource[], original?: string): TitleSource | undefined {
    if (!sources.length) return undefined;
    const { pick } = syncPolicy<{ pick: number | null }>({
      op: 'rank_releases',
      releases: rankable(sources),
      original,
      preferred: this.preferred(),
    });
    return pick === null ? undefined : sources[pick];
  }

  /** Fresh releases for a viewer choosing what to try beside the current partial download. */
  async alternatives(download: Download): Promise<TitleSource[] | null> {
    if (!this.resolve) return null;
    return (await this.resolve(download.title)).sources;
  }

  /**
   * Queue the viewer's choice beside the current release. The current partial stays primary and is never cancelled;
   * whichever reaches ready first wins through the same hedge path as an automatic retry.
   */
  async tryAnother(download: Download, source: TitleSource): Promise<Preparation> {
    const log = this.log;
    const clock = this.clock;
    if (!log || !clock) return { state: 'unknown', message: 'Downloads need your library.' };
    const row = log.settings(download.name);
    if (!row) return { state: 'unknown', message: 'That download is no longer in the queue.' };
    const current = readDownload(row);
    if (!current) return { state: 'unknown', message: 'That download is no longer in the queue.' };
    if (source.identity === current.release.identity)
      return this.answers.get(download.name) ?? { state: 'unknown' };
    if (current.release.hedge)
      return { state: 'unknown', message: 'This download is already trying two releases.' };
    clock.see(log.newestStamp());
    const now = Date.now();
    const hedge: DownloadHedge = {
      identity: source.identity,
      label: source.label,
      url: source.url,
      sizeBytes: source.size,
      cached: source.cached,
      queuedAt: now,
      lastProgress: 0,
      progressAt: now,
    };
    const saved = await log.write(
      withValues(row, {
        release: {
          value: releaseValue({ ...current.release, hedge }),
          at: clock.issue(),
        },
      }),
    );
    if (!saved) return { state: 'unknown', message: SAVE_FAILED };
    this.touch();
    return this.addHedge(download.name, source.url);
  }

  /** The URL this browser asks about a download with, or null until a resolve finds it one. */
  urlFor(download: Download): string | null {
    return this.urls.get(download.name) ?? this.ticket(download.release.url);
  }

  /**
   * Write the download down and ask scout to fetch it, as a prefetch: nobody is sitting in front of a download, so it
   * must not spend the adds scout keeps for Play. The answer comes back, so a press can say at once what happened.
   */
  async start({ title, source, sources }: StartInput): Promise<Preparation> {
    const name = downloadName(contentKeyOf(title));
    const pending = this.pending.get(name);
    if (pending) return pending;
    const run = this.startOnce(name, title, source, sources);
    this.pending.set(name, run);
    try {
      return await run;
    } finally {
      this.pending.delete(name);
    }
  }

  private async startOnce(
    name: string,
    title: DownloadTitle,
    source: TitleSource,
    sources?: TitleSource[],
  ): Promise<Preparation> {
    const log = this.log;
    const clock = this.clock;
    if (!log || !clock) return { state: 'unknown', message: 'Downloads need your library.' };
    clock.see(log.newestStamp());
    const candidates = sources
      ? sources.filter((s) => !(s.cached === false && s.seeders === 0)).length
      : undefined;
    const row = startRow(
      log.settings(name),
      {
        release: {
          identity: source.identity,
          label: source.label,
          url: source.url,
          sizeBytes: source.size,
          cached: source.cached,
        },
        title: { ...title, preferredLanguage: title.preferredLanguage ?? this.preferred() },
        candidates,
      },
      () => clock.issue(),
    );
    if (!(await log.write(row))) return { state: 'unknown', message: SAVE_FAILED };
    this.urls.set(name, source.url);
    this.clocks.delete(name);
    this.answers.set(name, { state: 'unknown', message: 'Starting download…' });
    this.touch();
    const answer = await this.prepare(source.url, true, true);
    this.answers.set(name, answer);
    if (answer.state === 'paused' && answer.until) {
      const current = log.settings(name);
      if (current)
        await log.write(
          withValues(current, { resumeAt: { value: { int: answer.until }, at: clock.issue() } }),
        );
      this.touch();
    }
    return answer;
  }

  /** Ask den-scout to fetch a release a download moved on to, or one held back whose time has come. */
  async add(name: string, url: string): Promise<Preparation> {
    this.urls.set(name, url);
    const answer = await this.prepare(url, true, true);
    this.answers.set(name, answer);
    this.touch();
    return answer;
  }

  /** Queue a persisted alternate without replacing the primary's answer or ticket. */
  async addHedge(name: string, url: string): Promise<Preparation> {
    this.hedgeUrls.set(name, url);
    const answer = await this.prepare(url, true, true);
    this.hedgeAnswers.set(name, answer);
    this.touch();
    return answer;
  }

  /** Ask about the alternate, renewing its device-local ticket by identity when necessary. */
  async pollHedge(download: Download): Promise<Preparation | undefined> {
    const hedge = download.release.hedge;
    if (!hedge) return undefined;
    let url = this.hedgeUrls.get(download.name) ?? this.ticket(hedge.url);
    if (!url && this.resolve) {
      const { sources } = await this.resolve(download.title);
      const same = sources?.find((source) => source.identity === hedge.identity);
      if (same) {
        url = same.url;
        this.hedgeUrls.set(download.name, url);
      }
    }
    if (!url) return undefined;
    const answer = await this.prepare(url, false, false);
    this.hedgeAnswers.set(download.name, answer);
    return answer;
  }

  /** The alternate became the row's primary. Carry its local state across without adding it again. */
  promoteHedge(download: Download): void {
    const answer = this.hedgeAnswers.get(download.name);
    const url = this.hedgeUrls.get(download.name) ?? download.release.hedge?.url;
    if (answer) this.answers.set(download.name, answer);
    if (url) this.urls.set(download.name, url);
    this.clearHedge(download.name);
  }

  clearHedge(name: string): void {
    this.hedgeAnswers.delete(name);
    this.hedgeUrls.delete(name);
  }

  /** Ask den-scout how a download is doing, without adding anything. */
  async poll(download: Download): Promise<Preparation> {
    const pending = this.pending.get(download.name);
    if (pending) return pending;
    const url = this.urlFor(download);
    if (!url) {
      // A ticket this browser can't ask with is a ticket to renew, which says nothing about the fetch.
      const expired: Preparation = { state: 'expired', message: FOREIGN };
      this.answers.set(download.name, expired);
      return expired;
    }
    const run = this.prepare(url, false, false).then((answer) => {
      this.answers.set(download.name, answer);
      return answer;
    });
    this.pending.set(download.name, run);
    try {
      return await run;
    } finally {
      this.pending.delete(download.name);
    }
  }

  /**
   * Find the same release again in a fresh resolve (by identity), for a ticket that lapsed or that this browser can't
   * reach. The URL is this browser's own until the lease holder writes it to the row. `gone` only on a list scout
   * answered in full; anything less is asked again next pass.
   */
  async renew(download: Download): Promise<string | 'gone' | null> {
    if (!this.resolve) return null;
    const { sources, answer } = await this.resolve(download.title);
    if (!sources) return null;
    const same = sources.find((s) => s.identity === download.release.identity);
    if (same) {
      this.urls.set(download.name, same.url);
      return same.url;
    }
    if (answer?.kind === 'partial' || answer?.kind === 'unknown' || answer?.outage) return null;
    this.answers.set(download.name, { state: 'expired', message: GONE });
    return 'gone';
  }

  /**
   * Take a download off the queue, for every device. With `cancel`, also drop it at the debrid — unless another
   * download in flight is fetching the same release (one season pack, several episodes), which only a client can see.
   */
  async remove(download: Download, cancel: boolean): Promise<boolean> {
    const log = this.log;
    const clock = this.clock;
    if (!log || !clock) return false;
    if (cancel) {
      await this.cancelIfSafe(download);
      await this.cancelHedgeIfSafe(download);
    }
    clock.see(log.newestStamp());
    const current = log.settings(download.name);
    if (!current) return true;
    const saved = await log.write(removedRow(current, clock.issue()));
    this.answers.delete(download.name);
    this.clocks.delete(download.name);
    this.urls.delete(download.name);
    this.clearHedge(download.name);
    this.touch();
    return !!saved;
  }

  /**
   * Cancel at the debrid, unless den-core's `download_cancel_safe` says another live row still names the release —
   * whatever that row's state: a sibling episode reading "not started" or "ready" may still be fetching or playing
   * the same season pack. Best effort: the outcome changes nothing. A refused check reads as "not safe" and never
   * throws: a fallback calls this after writing the next release and before adding it, which must still happen.
   */
  async cancelIfSafe(download: Download): Promise<void> {
    let safe = false;
    try {
      safe = syncPolicy<boolean>({
        op: 'download_cancel_safe',
        row: download.row,
        rows: this.list().map((d) => d.row),
      });
    } catch (error) {
      console.warn(
        `den: download ${download.content}: den-core refused the cancel check; not cancelling`,
        error,
      );
    }
    const url = this.urlFor(download);
    if (!safe || !url) return;
    await this.cancelRelease(url, false);
  }

  /** Cancel an alternate only when no other live row names it as either primary or alternate. */
  async cancelHedgeIfSafe(download: Download): Promise<void> {
    const hedge = download.release.hedge;
    if (!hedge) return;
    const shared = this.list().some(
      (other) =>
        other.name !== download.name &&
        (other.release.identity === hedge.identity ||
          other.release.hedge?.identity === hedge.identity),
    );
    const url = this.hedgeUrls.get(download.name) ?? this.ticket(hedge.url);
    if (!shared && url) await this.cancelRelease(url, false);
  }
}

/** Why a lapsed ticket's state reads as gone: the fresh list, answered in full, no longer carries the release. */
export const GONE = 'This release is no longer listed.';
/** A ticket another device wrote that this browser can't reach: renewed for this browser, never written back. */
export const FOREIGN = 'Another device’s ticket.';

export const downloads = new DownloadQueue();
