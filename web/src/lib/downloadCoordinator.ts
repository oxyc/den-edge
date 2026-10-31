import type { ClockStore } from './clockStore';
import {
  contentKeyOf,
  downloadName,
  readDownload,
  readDownloads,
  raceValue,
  releaseValue,
  removedRow,
  titleValue,
  withValues,
  type Download,
  type DownloadRaceEntry,
  type DownloadRelease,
  type DownloadTitle,
  type StallClock,
} from './downloadRows';
import type { WantedItem, WantedStatus } from './hearthWanted';
import type { LibraryLog } from './log';
import { readSyncedPrefs } from '../settings/values';
import { syncPolicy } from './syncCore';
import {
  answerOf,
  rankable,
  type Preparation,
  type SourceAnswer,
  type TitleSource,
} from './titleSources';
import type { ConfigValue, SettingsRow, Stamped } from './wire';

export const DOWNLOAD_POLL_MS = 5_000;
export const DOWNLOAD_POLL_MAX_MS = 60_000;
export const DOWNLOAD_SOURCE_SNAPSHOT_MS = 30_000;
const DOWNLOAD_SOURCE_SNAPSHOTS = 64;

export const downloadPollDelay = (quiet: number): number =>
  Math.min(DOWNLOAD_POLL_MS * 2 ** Math.max(0, quiet), DOWNLOAD_POLL_MAX_MS);

export interface DownloadStatus {
  state:
    | 'starting'
    | 'fetching'
    | 'not_started'
    | 'refused'
    | 'paused'
    | 'unreachable'
    | 'ready'
    | 'no_working_release'
    | 'awaiting_air'
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

/** `fresh` asks scout to rebuild the list past its caches (`?fresh=1`), for a viewer checking again by hand. */
export type DownloadResolve = (
  title: DownloadTitle,
  fresh?: boolean,
) => Promise<{
  sources: TitleSource[] | null;
  answer?: SourceAnswer;
  failure?: 'not-configured' | 'unmatched' | 'unreachable';
}>;

export interface DownloadSourceSnapshot {
  sources: TitleSource[] | null;
  answer?: SourceAnswer;
  failure?: 'not-configured' | 'unmatched' | 'unreachable';
}

export interface DownloadCoordinatorEffects {
  prepare(url: string, queue: boolean, prefetch: boolean): Promise<Preparation>;
  cancel(url: string, reannounce: boolean): Promise<boolean>;
  resolve: DownloadResolve;
  /** Maps a persisted ticket to one this service instance can reach. */
  ticket(url: string): string | null;
  /** Hand Hearth the wanted list and read back what it started (`hearthWanted`); absent with no Hearth. */
  wanted?(items: WantedItem[]): Promise<WantedStatus[] | null>;
}

export interface DownloadCoordinatorOptions {
  now?: () => number;
  monotonicNow?: () => number;
  changed?: () => void;
}

const GONE = 'This release is no longer listed.';
const FOREIGN = 'Another device’s ticket.';

/** A race entry's key in the per-entry maps: its row and its identity. */
export const raceKey = (name: string, identity: string) => `${name}\n${identity}`;

/**
 * Worker-safe state for the download domain. Durable rows are authoritative; answers and tickets are deliberately
 * instance-local capabilities. This class contains no Svelte state and owns no timers.
 */
export class DownloadCoordinator {
  readonly answers = new Map<string, Preparation>();
  /** By `raceKey`: den-scout's latest word on each race entry, and the ticket this instance reaches it by. */
  readonly entryAnswers = new Map<string, Preparation>();
  readonly entryUrls = new Map<string, string>();
  readonly clocks = new Map<string, StallClock>();
  readonly urls = new Map<string, string>();
  readonly lapsed = new Set<string>();
  readonly asked = new Map<string, { at: number; quiet: number; said: string }>();

  readonly #entryPolls = new Map<string, Promise<Preparation | undefined>>();
  readonly #pending = new Map<string, Promise<Preparation>>();
  readonly #enqueuePending = new Map<string, Promise<boolean>>();
  readonly #sourceCache = new Map<
    string,
    { expiresAt: number; snapshot: DownloadSourceSnapshot }
  >();
  readonly #sourcePending = new Map<string, Promise<DownloadSourceSnapshot>>();
  readonly now: () => number;
  readonly monotonicNow: () => number;
  readonly startedAt: number;
  readonly startedMono: number;
  readonly changed: () => void;

  constructor(
    readonly log: LibraryLog,
    readonly clock: ClockStore,
    readonly effects: DownloadCoordinatorEffects,
    options: DownloadCoordinatorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => globalThis.performance?.now() ?? 0);
    this.startedAt = this.now();
    this.startedMono = this.monotonicNow();
    this.changed = options.changed ?? (() => {});
  }

  get device(): string {
    return this.clock.device;
  }

  list(): Download[] {
    return readDownloads(this.log.rows()).map((download) => ({
      ...download,
      seq: this.log.seqOf(`set:${download.name}`),
    }));
  }

  get(name: string): Download | undefined {
    const row = this.log.settings(name);
    if (!row) return undefined;
    const download = readDownload(row);
    return download ? { ...download, seq: this.log.seqOf(`set:${download.name}`) } : undefined;
  }

  status(download: Download, now = this.now()): DownloadStatus {
    const answer = this.answers.get(download.name);
    const clock = this.clocks.get(download.name);
    const status = syncPolicy<DownloadStatus>({
      op: 'download_status',
      row: download.row,
      ...(answer ? { answer: answerOf(answer) } : {}),
      ...(clock ? { clock } : {}),
      now,
    });
    return status.state === null && answer?.message === GONE
      ? { ...status, state: 'release_gone' }
      : status;
  }

  pick(sources: TitleSource[], original?: string): TitleSource | undefined {
    if (!sources.length) return undefined;
    const preferred = readSyncedPrefs(this.log.settings('prefs')).audioLanguage;
    const { pick } = syncPolicy<{ pick: number | null }>({
      op: 'rank_releases',
      releases: rankable(sources),
      original,
      preferred,
    });
    return pick === null ? undefined : sources[pick];
  }

  async stamp(now = this.now()) {
    await this.clock.see(this.log.newestStamp());
    return this.clock.issue(now);
  }

  async enqueue(
    title: DownloadTitle,
    source: TitleSource,
    sources?: readonly TitleSource[] | number,
  ): Promise<boolean> {
    const name = downloadName(contentKeyOf(title));
    const pending = this.#enqueuePending.get(name);
    if (pending) return pending;
    const run = this.#enqueue(name, title, source, sources);
    this.#enqueuePending.set(name, run);
    try {
      return await run;
    } finally {
      if (this.#enqueuePending.get(name) === run) this.#enqueuePending.delete(name);
    }
  }

  async enqueueIdentity(
    title: DownloadTitle,
    identity: string,
    candidates?: number,
  ): Promise<boolean> {
    const { sources } = await this.sourcesForTitle(title);
    const source = sources?.find((candidate) => candidate.identity === identity);
    return source ? this.enqueue(title, source, candidates) : false;
  }

  async #enqueue(
    name: string,
    title: DownloadTitle,
    source: TitleSource,
    sources?: readonly TitleSource[] | number,
  ): Promise<boolean> {
    const now = this.now();
    const existing = this.log.settings(name);
    const current = existing ? readDownload(existing) : null;
    if (current && current.release.identity === source.identity && !current.exhausted) return true;
    const base: SettingsRow = existing ?? { kind: 'set', schema: 2, name, values: {} };
    const values: Record<string, Stamped<ConfigValue | null>> = {};
    if (existing) values.removed = { value: { bool: true }, at: await this.stamp(now) };
    const at = await this.stamp(now);
    const preferredLanguage = readSyncedPrefs(this.log.settings('prefs')).audioLanguage;
    const release: DownloadRelease = {
      identity: source.identity,
      label: source.label,
      url: source.url,
      sizeBytes: source.size,
      cached: source.cached,
    };
    values.release = { value: releaseValue(release), at };
    values.title = {
      value: titleValue({
        ...title,
        preferredLanguage: title.preferredLanguage ?? preferredLanguage,
      }),
      at,
    };
    values.queuedAt = { value: { int: now }, at };
    if (sources !== undefined)
      values.candidates = {
        value: {
          int:
            typeof sources === 'number'
              ? sources
              : sources.filter(
                  (candidate) => !(candidate.cached === false && candidate.seeders === 0),
                ).length,
        },
        at,
      };
    const row = withValues(base, values);
    if (!(await this.log.write(row))) return false;
    this.urls.set(name, source.url);
    this.clocks.delete(name);
    this.answers.set(name, { state: 'unknown', message: 'Starting download…' });
    this.changed();
    void this.#activate(name, source.url);
    return true;
  }

  /**
   * Ask for content that has nothing to fetch yet (§17 wanted row: `exhausted`, no `release`): an episode a season
   * download found no release for, or one not yet aired (`title.airDate`). The holder searches for it again on
   * den-core's `download_retry` schedule. A live row for the content is left as it is.
   */
  async want(title: DownloadTitle): Promise<boolean> {
    const name = downloadName(contentKeyOf(title));
    const existing = this.log.settings(name);
    if (existing && readDownload(existing)) return true;
    const now = this.now();
    const base: SettingsRow = existing ?? { kind: 'set', schema: 2, name, values: {} };
    const values: Record<string, Stamped<ConfigValue | null>> = {};
    if (existing) values.removed = { value: { bool: true }, at: await this.stamp(now) };
    const at = await this.stamp(now);
    const preferredLanguage = readSyncedPrefs(this.log.settings('prefs')).audioLanguage;
    values.title = {
      value: titleValue({
        ...title,
        preferredLanguage: title.preferredLanguage ?? preferredLanguage,
      }),
      at,
    };
    values.queuedAt = { value: { int: now }, at };
    values.exhausted = { value: { bool: true }, at };
    if (!(await this.log.write(withValues(base, values)))) return false;
    this.changed();
    return true;
  }

  async #activate(name: string, url: string): Promise<void> {
    try {
      const answer = await this.effects.prepare(url, true, true);
      if (this.urls.get(name) !== url) return;
      this.answers.set(name, answer);
      if (answer.state === 'paused' && answer.until) {
        const currentRow = this.log.settings(name);
        if (currentRow)
          await this.log.write(
            withValues(currentRow, {
              resumeAt: {
                value: { int: answer.until },
                at: await this.stamp(),
              },
            }),
          );
      }
      this.changed();
    } catch (error) {
      console.warn('den: download activation failed', error);
    }
  }

  async remove(download: Download, cancel: boolean): Promise<boolean> {
    if (cancel) {
      await this.cancelIfSafe(download);
      for (const entry of download.race.entries)
        await this.cancelEntryIfSafe(download, entry.identity, this.entryUrl(download, entry));
    }
    const current = this.log.settings(download.name);
    if (!current) return true;
    const saved = await this.log.write(removedRow(current, await this.stamp()));
    if (!saved) return false;
    this.answers.delete(download.name);
    this.clocks.delete(download.name);
    this.urls.delete(download.name);
    this.clearEntries(download.name);
    this.changed();
    return true;
  }

  /** "Try another": the chosen release joins the race beside what is already fetching (§17 *Racing*). */
  async tryRelease(download: Download, source: TitleSource): Promise<boolean> {
    const current = this.get(download.name);
    if (
      !current ||
      source.identity === current.release.identity ||
      current.race.entries.some((entry) => entry.identity === source.identity)
    )
      return false;
    const now = this.now();
    const entry: DownloadRaceEntry = {
      identity: source.identity,
      label: source.label,
      url: source.url,
      sizeBytes: source.size,
      cached: source.cached,
      queuedAt: now,
    };
    const race = { ...current.race, entries: [...current.race.entries, entry] };
    const saved = await this.log.write(
      withValues(current.row, { race: { value: raceValue(race), at: await this.stamp(now) } }),
    );
    if (!saved) return false;
    this.changed();
    void this.addEntry(download.name, source.identity, source.url).catch((error: unknown) =>
      console.warn('den: alternate download activation failed', error),
    );
    return true;
  }

  async releases(download: Download): Promise<TitleSource[] | null> {
    return (await this.sourcesForTitle(download.title)).sources;
  }

  async releasesForTitle(title: DownloadTitle): Promise<TitleSource[] | null> {
    return (await this.sourcesForTitle(title)).sources;
  }

  /**
   * One short-lived worker-owned snapshot backs display and the action selected from it. Tickets never leave this
   * object, and a click does not repeat the provider request that produced the visible list.
   */
  async sourcesForTitle(
    title: DownloadTitle,
    refresh = false,
    fresh = false,
  ): Promise<DownloadSourceSnapshot> {
    const key = contentKeyOf(title);
    const now = this.now();
    const cached = this.#sourceCache.get(key);
    if (!refresh && !fresh && cached && cached.expiresAt > now) return cached.snapshot;
    // A fresh ask never joins a plain one already running: that one may be answered from the caches it skips.
    const pending = this.#sourcePending.get(key);
    if (pending && !fresh) return pending;
    const run = this.effects.resolve(title, fresh).then(({ sources, answer, failure }) => {
      const preferred = sources?.length ? this.pick(sources, title.originalLanguage) : undefined;
      const ordered = preferred
        ? [preferred, ...sources!.filter((source) => source.identity !== preferred.identity)]
        : sources;
      const snapshot: DownloadSourceSnapshot = {
        sources: ordered ?? null,
        ...(answer ? { answer } : {}),
        ...(failure ? { failure } : {}),
      };
      this.#sourceCache.delete(key);
      this.#sourceCache.set(key, {
        expiresAt: this.now() + DOWNLOAD_SOURCE_SNAPSHOT_MS,
        snapshot,
      });
      while (this.#sourceCache.size > DOWNLOAD_SOURCE_SNAPSHOTS)
        this.#sourceCache.delete(this.#sourceCache.keys().next().value!);
      return snapshot;
    });
    this.#sourcePending.set(key, run);
    try {
      return await run;
    } finally {
      if (this.#sourcePending.get(key) === run) this.#sourcePending.delete(key);
    }
  }

  async tryReleaseIdentity(download: Download, identity: string): Promise<boolean> {
    const sources = await this.releases(download);
    const source = sources?.find((candidate) => candidate.identity === identity);
    return source ? this.tryRelease(download, source) : false;
  }

  urlFor(download: Download): string | null {
    return this.urls.get(download.name) ?? this.effects.ticket(download.release.url);
  }

  async add(name: string, url: string): Promise<Preparation> {
    this.urls.set(name, url);
    const answer = await this.effects.prepare(url, true, true);
    if (this.urls.get(name) === url) this.answers.set(name, answer);
    this.changed();
    return answer;
  }

  async poll(download: Download): Promise<Preparation> {
    const pending = this.#pending.get(download.name);
    if (pending) return pending;
    const url = this.urlFor(download);
    if (!url) {
      const expired: Preparation = { state: 'expired', message: FOREIGN };
      this.answers.set(download.name, expired);
      return expired;
    }
    const run = this.effects.prepare(url, false, false);
    this.#pending.set(download.name, run);
    try {
      const answer = await run;
      if (this.#pending.get(download.name) === run) this.answers.set(download.name, answer);
      return answer;
    } finally {
      if (this.#pending.get(download.name) === run) this.#pending.delete(download.name);
    }
  }

  async renew(download: Download): Promise<string | 'gone' | null> {
    const { sources, answer } = await this.sourcesForTitle(download.title, true);
    if (!sources) return null;
    const same = sources.find((source) => source.identity === download.release.identity);
    if (same) {
      this.urls.set(download.name, same.url);
      return same.url;
    }
    if (answer?.kind === 'partial' || answer?.kind === 'unknown' || answer?.outage) return null;
    this.answers.set(download.name, { state: 'expired', message: GONE });
    return 'gone';
  }

  /** Add a race entry at the debrid, as a prefetch. A refusal (`refused`) is its active-download limit. */
  async addEntry(name: string, identity: string, url: string): Promise<Preparation> {
    const key = raceKey(name, identity);
    this.entryUrls.set(key, url);
    const answer = await this.effects.prepare(url, true, true);
    if (this.entryUrls.get(key) === url) this.entryAnswers.set(key, answer);
    this.changed();
    return answer;
  }

  /** The ticket this instance reaches a race entry by, without asking anyone. */
  entryUrl(download: Download, entry: DownloadRaceEntry): string | null {
    return (
      this.entryUrls.get(raceKey(download.name, entry.identity)) ?? this.effects.ticket(entry.url)
    );
  }

  /**
   * The ticket for a race entry, renewed from a fresh resolve when this instance can't reach the written one; `gone`
   * when a full answer no longer lists it, undefined when no answer settles it.
   */
  async renewEntryUrl(
    download: Download,
    entry: DownloadRaceEntry,
  ): Promise<string | 'gone' | undefined> {
    const known = this.entryUrl(download, entry);
    if (known) return known;
    const { sources, answer } = await this.sourcesForTitle(download.title, true);
    if (!sources) return undefined;
    const same = sources.find((source) => source.identity === entry.identity);
    if (same) {
      this.entryUrls.set(raceKey(download.name, entry.identity), same.url);
      return same.url;
    }
    return answer?.kind === 'partial' || answer?.kind === 'unknown' || answer?.outage
      ? undefined
      : 'gone';
  }

  /** Ask den-scout about one race entry (`?probe=1`). A release no longer listed reads as failed. */
  async pollEntry(download: Download, entry: DownloadRaceEntry): Promise<Preparation | undefined> {
    const key = raceKey(download.name, entry.identity);
    const pending = this.#entryPolls.get(key);
    if (pending) return pending;
    const run = (async () => {
      const url = await this.renewEntryUrl(download, entry);
      if (url === 'gone') return { state: 'failed', message: GONE } satisfies Preparation;
      return url ? this.effects.prepare(url, false, false) : undefined;
    })();
    this.#entryPolls.set(key, run);
    try {
      const answer = await run;
      if (answer && this.#entryPolls.get(key) === run) this.entryAnswers.set(key, answer);
      return answer;
    } finally {
      if (this.#entryPolls.get(key) === run) this.#entryPolls.delete(key);
    }
  }

  /** A race entry that won becomes the row's release: its answer and ticket move with it. */
  promoteEntry(download: Download, entry: DownloadRaceEntry): void {
    const key = raceKey(download.name, entry.identity);
    const answer = this.entryAnswers.get(key);
    const url = this.entryUrls.get(key) ?? this.effects.ticket(entry.url);
    if (answer) this.answers.set(download.name, answer);
    if (url) this.urls.set(download.name, url);
    this.forgetEntry(download.name, entry.identity);
  }

  forgetEntry(name: string, identity: string): void {
    const key = raceKey(name, identity);
    this.entryAnswers.delete(key);
    this.entryUrls.delete(key);
    this.#entryPolls.delete(key);
  }

  clearEntries(name: string): void {
    for (const map of [this.entryAnswers, this.entryUrls, this.#entryPolls])
      for (const key of [...map.keys()]) if (key.startsWith(`${name}\n`)) map.delete(key);
  }

  #cancelSafe(download: Download, identity?: string): boolean {
    try {
      return syncPolicy<boolean>({
        op: 'download_cancel_safe',
        row: download.row,
        rows: this.list().map((item) => item.row),
        ...(identity ? { identity } : {}),
      });
    } catch (error) {
      console.warn(`den: download ${download.content}: cancel check refused`, error);
      return false;
    }
  }

  async cancelIfSafe(download: Download): Promise<void> {
    const url = this.urlFor(download);
    if (this.#cancelSafe(download) && url) await this.effects.cancel(url, false);
  }

  /** Cancel one release the row races, unless another row still names or races it (`download_cancel_safe`). */
  async cancelEntryIfSafe(download: Download, identity: string, url: string | null): Promise<void> {
    if (this.#cancelSafe(download, identity) && url) await this.effects.cancel(url, false);
  }
}

export const downloadIsInFlight = (state: DownloadStatus['state']) =>
  state === 'starting' || state === 'fetching' || state === 'not_started' || state === 'paused';
