import type { ClockStore } from './clockStore';
import {
  contentKeyOf,
  downloadName,
  readDownload,
  readDownloads,
  releaseValue,
  removedRow,
  titleValue,
  withValues,
  type Download,
  type DownloadHedge,
  type DownloadRelease,
  type DownloadTitle,
  type StallClock,
} from './downloadRows';
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

export type DownloadResolve = (
  title: DownloadTitle,
) => Promise<{ sources: TitleSource[] | null; answer?: SourceAnswer }>;

export interface DownloadCoordinatorEffects {
  prepare(url: string, queue: boolean, prefetch: boolean): Promise<Preparation>;
  cancel(url: string, reannounce: boolean): Promise<boolean>;
  resolve: DownloadResolve;
  /** Maps a persisted ticket to one this service instance can reach. */
  ticket(url: string): string | null;
}

export interface DownloadCoordinatorOptions {
  now?: () => number;
  monotonicNow?: () => number;
  changed?: () => void;
}

const GONE = 'This release is no longer listed.';
const FOREIGN = 'Another device’s ticket.';

/**
 * Worker-safe state for the download domain. Durable rows are authoritative; answers and tickets are deliberately
 * instance-local capabilities. This class contains no Svelte state and owns no timers.
 */
export class DownloadCoordinator {
  readonly answers = new Map<string, Preparation>();
  readonly hedgeAnswers = new Map<string, Preparation>();
  readonly clocks = new Map<string, StallClock>();
  readonly urls = new Map<string, string>();
  readonly hedgeUrls = new Map<string, string>();
  readonly lapsed = new Set<string>();
  readonly asked = new Map<string, { at: number; quiet: number; said: string }>();

  readonly #hedgeIdentities = new Map<string, string>();
  readonly #hedgeTokens = new Map<string, number>();
  readonly #noHedgeUntil = new Map<string, { key: string; until: number }>();
  readonly #pending = new Map<string, Promise<Preparation>>();
  readonly #enqueuePending = new Map<string, Promise<boolean>>();
  readonly #hedgePending = new Map<
    string,
    { identity: string; url: string; run: Promise<Preparation> }
  >();
  readonly #hedgePolls = new Map<
    string,
    { identity: string; run: Promise<Preparation | undefined> }
  >();
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
    const { sources } = await this.effects.resolve(title);
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
    const base: SettingsRow = existing ?? { kind: 'set', schema: 2, name, values: {} };
    let row: SettingsRow;
    if (current && current.release.identity === source.identity && !current.exhausted) {
      row = withValues(base, {
        queuedAt: { value: { int: now }, at: await this.stamp(now) },
      });
    } else {
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
      row = withValues(base, values);
    }
    if (!(await this.log.write(row))) return false;
    this.urls.set(name, source.url);
    this.clocks.delete(name);
    this.answers.set(name, { state: 'unknown', message: 'Starting download…' });
    this.changed();
    void this.#activate(name, source.url);
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
      await this.cancelHedgeIfSafe(download);
    }
    const current = this.log.settings(download.name);
    if (!current) return true;
    const saved = await this.log.write(removedRow(current, await this.stamp()));
    if (!saved) return false;
    this.answers.delete(download.name);
    this.clocks.delete(download.name);
    this.urls.delete(download.name);
    this.clearHedge(download.name);
    this.changed();
    return true;
  }

  async tryRelease(download: Download, source: TitleSource): Promise<boolean> {
    const current = this.get(download.name);
    if (!current || source.identity === current.release.identity || current.release.hedge)
      return false;
    const now = this.now();
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
    const saved = await this.log.write(
      withValues(current.row, {
        release: {
          value: releaseValue({ ...current.release, hedge }),
          at: await this.stamp(now),
        },
      }),
    );
    if (!saved) return false;
    this.changed();
    void this.addHedge(download.name, source.url, source.identity).catch((error: unknown) =>
      console.warn('den: alternate download activation failed', error),
    );
    return true;
  }

  async releases(download: Download): Promise<TitleSource[] | null> {
    return this.releasesForTitle(download.title);
  }

  async releasesForTitle(title: DownloadTitle): Promise<TitleSource[] | null> {
    const { sources } = await this.effects.resolve(title);
    if (!sources?.length) return sources;
    const preferred = this.pick(sources, title.originalLanguage);
    return preferred
      ? [preferred, ...sources.filter((source) => source.identity !== preferred.identity)]
      : sources;
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
    const { sources, answer } = await this.effects.resolve(download.title);
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

  async addHedge(name: string, url: string, identity = url): Promise<Preparation> {
    const pending = this.#hedgePending.get(name);
    if (pending?.identity === identity && pending.url === url) return pending.run;
    if (this.#hedgeIdentities.get(name) !== identity) this.clearHedge(name);
    this.#hedgeIdentities.set(name, identity);
    this.hedgeUrls.set(name, url);
    const run = this.effects.prepare(url, true, true);
    this.#hedgePending.set(name, { identity, url, run });
    try {
      const answer = await run;
      if (this.#hedgePending.get(name)?.run === run && this.hedgeUrls.get(name) === url)
        this.hedgeAnswers.set(name, answer);
      return answer;
    } finally {
      if (this.#hedgePending.get(name)?.run === run) this.#hedgePending.delete(name);
    }
  }

  async pollHedge(download: Download): Promise<Preparation | undefined> {
    const hedge = download.release.hedge;
    if (!hedge) return undefined;
    if (
      this.#hedgeIdentities.has(download.name) &&
      this.#hedgeIdentities.get(download.name) !== hedge.identity
    )
      this.clearHedge(download.name);
    const adding = this.#hedgePending.get(download.name);
    if (adding?.identity === hedge.identity) return adding.run;
    const pending = this.#hedgePolls.get(download.name);
    if (pending?.identity === hedge.identity) return pending.run;
    const token = this.#hedgeTokens.get(download.name) ?? 0;
    const run = this.#pollHedge(download, token);
    this.#hedgePolls.set(download.name, { identity: hedge.identity, run });
    try {
      const answer = await run;
      if (answer && this.#hedgePolls.get(download.name)?.run === run)
        this.hedgeAnswers.set(download.name, answer);
      return answer;
    } finally {
      if (this.#hedgePolls.get(download.name)?.run === run) this.#hedgePolls.delete(download.name);
    }
  }

  async #pollHedge(download: Download, token: number): Promise<Preparation | undefined> {
    const url = await this.hedgeUrl(download, token);
    return url ? this.effects.prepare(url, false, false) : undefined;
  }

  async hedgeUrl(download: Download, token = this.#hedgeTokens.get(download.name) ?? 0) {
    const hedge = download.release.hedge;
    if (!hedge) return undefined;
    let url =
      (this.#hedgeIdentities.get(download.name) === hedge.identity
        ? this.hedgeUrls.get(download.name)
        : undefined) ??
      this.effects.ticket(hedge.url) ??
      undefined;
    if (!url) {
      const { sources } = await this.effects.resolve(download.title);
      if ((this.#hedgeTokens.get(download.name) ?? 0) !== token) return undefined;
      const same = sources?.find((source) => source.identity === hedge.identity);
      if (same) {
        url = same.url;
        this.#hedgeIdentities.set(download.name, hedge.identity);
        this.hedgeUrls.set(download.name, url);
      }
    }
    return (this.#hedgeTokens.get(download.name) ?? 0) === token ? url : undefined;
  }

  async resumeHedge(download: Download, current: () => boolean): Promise<Preparation | undefined> {
    const token = this.#hedgeTokens.get(download.name) ?? 0;
    const url = await this.hedgeUrl(download, token);
    return url && current()
      ? this.addHedge(download.name, url, download.release.hedge?.identity)
      : undefined;
  }

  hedgeResolveDue(download: Download, now: number): boolean {
    const key = JSON.stringify([
      download.content,
      download.release.identity,
      download.queuedAt,
      [...download.tried].sort(),
    ]);
    const remembered = this.#noHedgeUntil.get(download.name);
    if (!remembered || remembered.key !== key) {
      if (remembered) this.#noHedgeUntil.delete(download.name);
      return true;
    }
    return now >= remembered.until;
  }

  rememberNoHedge(download: Download, until: number): void {
    this.#noHedgeUntil.set(download.name, {
      key: JSON.stringify([
        download.content,
        download.release.identity,
        download.queuedAt,
        [...download.tried].sort(),
      ]),
      until,
    });
  }

  promoteHedge(download: Download): void {
    const answer = this.hedgeAnswers.get(download.name);
    const url = this.hedgeUrls.get(download.name) ?? download.release.hedge?.url;
    if (answer) this.answers.set(download.name, answer);
    if (url) this.urls.set(download.name, url);
    this.clearHedge(download.name);
  }

  clearHedge(name: string): void {
    this.#hedgeTokens.set(name, (this.#hedgeTokens.get(name) ?? 0) + 1);
    this.#hedgePending.delete(name);
    this.#hedgePolls.delete(name);
    this.hedgeAnswers.delete(name);
    this.#hedgeIdentities.delete(name);
    this.hedgeUrls.delete(name);
  }

  async cancelIfSafe(download: Download): Promise<void> {
    let safe = false;
    try {
      safe = syncPolicy<boolean>({
        op: 'download_cancel_safe',
        row: download.row,
        rows: this.list().map((item) => item.row),
      });
    } catch (error) {
      console.warn(`den: download ${download.content}: cancel check refused`, error);
    }
    const url = this.urlFor(download);
    if (safe && url) await this.effects.cancel(url, false);
  }

  async cancelHedgeIfSafe(download: Download): Promise<void> {
    const hedge = download.release.hedge;
    if (!hedge) return;
    const shared = this.list().some(
      (other) =>
        other.name !== download.name &&
        (other.release.identity === hedge.identity ||
          other.release.hedge?.identity === hedge.identity),
    );
    const url = this.hedgeUrls.get(download.name) ?? this.effects.ticket(hedge.url);
    if (!shared && url) await this.effects.cancel(url, false);
  }
}

export const downloadIsInFlight = (state: DownloadStatus['state']) =>
  state === 'starting' || state === 'fetching' || state === 'paused';
