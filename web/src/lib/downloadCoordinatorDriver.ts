import {
  DOWNLOAD_POLL_MAX_MS,
  downloadPollDelay,
  type DownloadCoordinator,
  type DownloadStatus,
} from './downloadCoordinator';
import {
  clockValue,
  emptyRow,
  LEASE_ROW,
  releaseValue,
  removedRow,
  withValues,
  type Download,
  type DownloadHedge,
} from './downloadRows';
import { wantedItems, type WantedStatus } from './hearthWanted';
import { applyLog, contentWatched, emptyLibrary } from './library';
import { syncPolicy } from './syncCore';
import { rankable, type SourceAnswer, type TitleSource } from './titleSources';
import type { ConfigValue, SettingsRow, Stamped, Stamp } from './wire';

const CONCURRENCY = 4;
const NO_HEDGE_MS = 10 * 60_000;
/** A due search whose answer couldn't settle anything (a source unreachable or partial) is asked again after this. */
const UNANSWERED_WAIT = 5 * 60_000;
/** An unchanged wanted list is handed to Hearth again, and what it started read back, this often. */
const HEARTH_EVERY = 5 * 60_000;
const ANOTHER_WINDOW = 'another-window';
const FOREIGN = 'Another device’s ticket.';
const GONE = 'This release is no longer listed.';

interface Held {
  epoch: number;
  at: number;
  mono: number;
}

interface Observed {
  seq: number;
  at: number;
  mono: number;
}

export interface DownloadDriveOptions {
  now?: number;
  observedFor?: number;
  force?: boolean;
  current?: () => boolean;
  names?: ReadonlySet<string>;
}

/** Serial, worker-owned lifecycle for one coordinator. It deliberately owns no timer; the service scheduler calls it. */
export class DownloadCoordinatorDriver {
  #held?: Held;
  #observed?: Observed;
  #running?: Promise<boolean>;
  /** By row name: when a due search that got an incomplete answer may ask again. */
  readonly #unanswered = new Map<string, number>();
  /** The wanted list last handed to Hearth, and when. */
  #hearthSent?: { digest: string; at: number };

  constructor(readonly queue: DownloadCoordinator) {}

  run(options: DownloadDriveOptions = {}): Promise<boolean> {
    if (this.#running) return this.#running;
    const running = this.#run(options);
    this.#running = running;
    void running.finally(() => {
      if (this.#running === running) this.#running = undefined;
    });
    return running;
  }

  async #run(options: DownloadDriveOptions): Promise<boolean> {
    const now = options.now ?? this.queue.now();
    const current = options.current ?? (() => true);
    const downloads = this.queue
      .list()
      .filter((download) => !options.names || options.names.has(download.name));
    await this.#refresh(downloads, now, options.force ?? false, current);
    if (!current() || !downloads.length) return false;
    if (!(await this.#holdLease(now, options.observedFor))) return false;
    return this.#holderPass(now, current);
  }

  async #refresh(
    downloads: Download[],
    now: number,
    force: boolean,
    current: () => boolean,
  ): Promise<void> {
    const polled = downloads.filter((download) => {
      const state = this.queue.status(download, now).state;
      if (
        (force && state === 'ready') ||
        state === 'no_working_release' ||
        state === 'awaiting_air' ||
        state === 'release_gone' ||
        state === 'paused'
      )
        return false;
      const last = this.queue.asked.get(download.name);
      return force || !last || now - last.at >= downloadPollDelay(last.quiet);
    });
    for (let index = 0; index < polled.length; index += CONCURRENCY) {
      if (!current()) break;
      await Promise.all(
        polled.slice(index, index + CONCURRENCY).map(async (download) => {
          await this.#pollAndRenew(download, current);
          if (!current()) return;
          const said = JSON.stringify([
            this.queue.answers.get(download.name) ?? null,
            this.queue.hedgeAnswers.get(download.name) ?? null,
          ]);
          const last = this.queue.asked.get(download.name);
          this.queue.asked.set(download.name, {
            at: now,
            quiet: last?.said === said ? last.quiet + 1 : 0,
            said,
          });
        }),
      );
    }
    if (current()) this.queue.changed();
  }

  async #pollAndRenew(download: Download, current: () => boolean): Promise<void> {
    const answer = await this.queue.poll(download);
    if (!current()) return;
    if (download.release.hedge) await this.queue.pollHedge(download);
    if (!current() || answer.state !== 'expired' || answer.message === GONE) return;
    const url = await this.queue.renew(download);
    if (!current() || url === null || url === 'gone') return;
    if (answer.message !== FOREIGN) this.queue.lapsed.add(download.name);
    await this.queue.poll(download);
  }

  #since(at: number, mono: number, now: number): number | undefined {
    const wall = now - at;
    if (wall < 0) return undefined;
    return Math.max(wall, this.queue.monotonicNow() - mono);
  }

  async #holdLease(now: number, observedFor?: number): Promise<boolean> {
    const log = this.queue.log;
    const name = `set:${LEASE_ROW}`;
    const row = log.settings(LEASE_ROW);
    const seq = log.seqOf(name);
    const value = row?.values.lease?.value;
    const [holder = '', epochText = '0'] = value && 'strings' in value ? value.strings : [];
    const epoch = Number(epochText) || 0;
    const mono = this.queue.monotonicNow();
    if (!this.#observed || this.#observed.seq !== seq) this.#observed = { seq, at: now, mono };
    const watched =
      this.#observed.seq === seq
        ? (this.#since(this.#observed.at, this.#observed.mono, now) ?? 0)
        : 0;
    const mine = this.#held;
    const ours = holder === this.queue.device && mine?.epoch === epoch;
    const openFor =
      observedFor ??
      Math.max(now - this.queue.startedAt, this.queue.monotonicNow() - this.queue.startedMono);
    const decision = syncPolicy<{ action: string; epoch?: number }>({
      op: 'lease',
      input: {
        device: this.queue.device,
        holder: ours ? this.queue.device : holder === this.queue.device ? ANOTHER_WINDOW : holder,
        epoch,
        elapsed: ours && mine ? this.#since(mine.at, mine.mono, now) : undefined,
        observed: Math.max(watched, holder ? 0 : openFor),
        fresh_generation: false,
      },
    });
    if (decision.action === 'send') return true;
    if (decision.action !== 'take' && decision.action !== 'renew') {
      if (decision.action === 'stop') this.#held = undefined;
      return false;
    }
    const next = decision.epoch ?? epoch + 1;
    const base: SettingsRow = row ?? emptyRow(LEASE_ROW);
    const at = await this.queue.stamp(now);
    const leased: SettingsRow = {
      ...base,
      values: {
        ...base.values,
        lease: { value: { strings: [this.queue.device, String(next)] }, at },
      },
    };
    if (!(await log.writeAt(leased, seq))) {
      this.#held = undefined;
      return false;
    }
    this.#held = { epoch: next, at: now, mono };
    this.#observed = { seq: log.seqOf(name), at: now, mono };
    return true;
  }

  #stillHeld(now: number): boolean {
    const mine = this.#held;
    const elapsed = mine ? this.#since(mine.at, mine.mono, now) : undefined;
    if (!mine || elapsed === undefined || elapsed >= 120_000) return false;
    const value = this.queue.log.settings(LEASE_ROW)?.values.lease?.value;
    const [holder, epoch] = value && 'strings' in value ? value.strings : [];
    return holder === this.queue.device && Number(epoch) === mine.epoch;
  }

  async #stamp(now: number): Promise<Stamp> {
    return this.queue.stamp(now);
  }

  async #write(
    download: Download,
    values: Record<string, Stamped<ConfigValue | null>>,
    now: number,
  ): Promise<boolean> {
    if (!this.#stillHeld(now)) return false;
    return this.queue.log.writeAt(withValues(download.row, values), download.seq);
  }

  async #holderPass(now: number, current: () => boolean): Promise<boolean> {
    let wrote = await this.#syncHearth(now, current);
    const states: Record<string, string> = {};
    const decided = this.queue.list();
    for (const download of decided) {
      if (!current() || !this.#stillHeld(now)) break;
      const status = this.queue.status(download, now);
      if (status.state) states[download.name] = status.state;
      this.queue.clocks.set(download.name, status.clock);
      if (download.exhausted) {
        // Never given up on: den-core says when it searches again (backing off to 6 h, never before its air date).
        const retry = syncPolicy<{ due: boolean; at: number; attempt: number }>({
          op: 'download_retry',
          row: download.row,
          now,
        });
        if (retry.due && now >= (this.#unanswered.get(download.name) ?? 0))
          wrote = (await this.#retryExhausted(download, retry.attempt, now)) || wrote;
        continue;
      }
      if (download.release.hedge) {
        if (status.state === 'ready') {
          wrote = (await this.#primaryWon(download, now)) || wrote;
          continue;
        }
        const alternate = this.queue.hedgeAnswers.get(download.name);
        if (alternate?.state === 'ready') {
          wrote = (await this.#hedgeWon(download, now)) || wrote;
          continue;
        }
        if (alternate?.state === 'not-queued') {
          await this.queue.resumeHedge(download, () => current() && this.#stillHeld(now));
          continue;
        }
        if (
          alternate?.state === 'preparing' &&
          alternate.progress !== undefined &&
          alternate.progress > (download.release.hedge.lastProgress ?? 0) &&
          now - download.release.hedge.progressAt >= DOWNLOAD_POLL_MAX_MS
        ) {
          const hedge = {
            ...download.release.hedge,
            lastProgress: alternate.progress,
            progressAt: now,
          };
          wrote =
            (await this.#write(
              download,
              {
                release: {
                  value: releaseValue({ ...download.release, hedge }),
                  at: await this.#stamp(now),
                },
              },
              now,
            )) || wrote;
          continue;
        }
      }
      if (
        status.state === 'starting' &&
        download.resumeAt !== undefined &&
        download.resumeAt <= now
      ) {
        const url = this.queue.urlFor(download);
        if (url && (await this.#write(download, await this.#resumed(now), now))) {
          wrote = true;
          await this.queue.add(download.name, url);
        }
        continue;
      }
      if (this.queue.lapsed.has(download.name)) {
        wrote = (await this.#writeTicket(download, now)) || wrote;
        continue;
      }
      // A release the addon stopped listing won't arrive: move on, as for a stall. Before `renew`, which the lapsed
      // ticket that found it gone still carries.
      if (status.state === 'release_gone' && !download.release.hedge) {
        wrote = (await this.#fallBack(download, status, now)) || wrote;
        continue;
      }
      if (status.renew) continue;
      if (status.stalled) {
        const answer = this.queue.answers.get(download.name);
        const progress =
          answer?.progress ?? download.progress?.lastProgress ?? status.clock.lastProgress;
        if (!download.release.hedge && answer?.fetch?.state !== 'failed' && progress > 0)
          wrote = (await this.#startHedge(download, now)) || wrote;
        else if (!download.release.hedge)
          wrote = (await this.#fallBack(download, status, now)) || wrote;
        continue;
      }
      const values: Record<string, Stamped<ConfigValue | null>> = {};
      if (status.report || status.announce || status.write_progress || status.reannounce) {
        const at = await this.#stamp(now);
        if (status.report) values.reported = { value: { bool: true }, at };
        if (status.announce) values.announced = { value: { bool: true }, at };
        if (status.write_progress) values.progress = { value: clockValue(status.clock), at };
        if (status.reannounce) values.reannounced = { value: { bool: true }, at };
      }
      if (!Object.keys(values).length) continue;
      const written = await this.#write(download, values, now);
      wrote = written || wrote;
      const url = status.reannounce && written ? this.queue.urlFor(download) : undefined;
      if (url) await this.queue.effects.cancel(url, true);
    }

    if (current() && this.#stillHeld(now)) {
      const library = applyLog(emptyLibrary(), this.queue.log.rows());
      const watched: Record<string, boolean> = {};
      for (const download of decided)
        if (
          contentWatched(library, {
            type: download.title.mediaType,
            id: download.title.mediaId,
            season: download.title.season,
            episode: download.title.episode,
          })
        )
          watched[download.name] = true;
      const pruned = syncPolicy<{ remove: string[] }>({
        op: 'download_prune',
        rows: decided.map((download) => download.row),
        states,
        watched,
        now,
      });
      const byName = new Map(decided.map((download) => [download.name, download]));
      for (const name of pruned.remove) {
        const download = byName.get(name);
        if (!download || !this.#stillHeld(now)) continue;
        wrote =
          (await this.queue.log.writeAt(
            removedRow(download.row, await this.#stamp(now)),
            download.seq,
          )) || wrote;
      }
    }
    if (wrote) this.queue.changed();
    return wrote;
  }

  /**
   * The wanted list handed to Hearth, which searches on while no client is open, and what it started adopted. Sent when
   * it changed and otherwise every few minutes (an empty one once, to clear what Hearth holds).
   */
  async #syncHearth(now: number, current: () => boolean): Promise<boolean> {
    const send = this.queue.effects.wanted;
    if (!send) return false;
    const items = wantedItems(this.queue.list());
    const digest = JSON.stringify(items);
    const last = this.#hearthSent;
    if (last?.digest === digest && (!items.length || now - last.at < HEARTH_EVERY)) return false;
    this.#hearthSent = { digest, at: now };
    const statuses = await send(items);
    if (!statuses || !current()) return false;
    let wrote = false;
    for (const status of statuses) {
      if (status.state !== 'started' || !status.identity || !this.#stillHeld(now)) continue;
      const download = this.queue
        .list()
        .find((candidate) => candidate.content === status.key && candidate.exhausted);
      if (!download || download.tried.includes(status.identity)) continue;
      wrote = (await this.#adopt(download, status, now)) || wrote;
    }
    return wrote;
  }

  /**
   * A release Hearth started for a wanted download, written into its row as the holder's own pick (§17): found again in
   * this client's own list by its identity, so the row names a ticket this client can use.
   */
  async #adopt(download: Download, status: WantedStatus, now: number): Promise<boolean> {
    const { sources } = await this.queue.sourcesForTitle(download.title, true);
    if (!this.#stillHeld(now) || !sources) return false;
    const chosen = sources.find((source) => source.identity === status.identity);
    if (!chosen) {
      console.info(
        `den: download ${download.content}: Hearth's start isn't listed here; searching on`,
      );
      return false;
    }
    console.info(`den: download ${download.content}: Hearth started ${chosen.label} meanwhile`);
    return this.#start(
      download,
      chosen,
      {
        retries: Math.max(download.retries, status.retries ?? 0),
        tried: download.tried,
        candidates: sources.filter((source) => !(source.cached === false && source.seeders === 0))
          .length,
        queuedAt: status.startedAt ?? now,
      },
      now,
    );
  }

  /**
   * A due fresh search for an exhausted (or wanted) download (§17 *Searching again*): the next untried release, or
   * with every one tried, the best of them all again. Nothing to pick writes a fresh `exhausted`, so the next search
   * waits longer; an answer that can't settle it writes nothing and asks again shortly.
   */
  async #retryExhausted(download: Download, attempt: number, now: number): Promise<boolean> {
    const { sources, answer } = await this.queue.sourcesForTitle(download.title, true);
    if (!this.#stillHeld(now)) return false;
    if (sources === null || !completeAnswer(answer)) {
      this.#unanswered.set(download.name, now + UNANSWERED_WAIT);
      console.info(`den: download ${download.content}: search ${attempt + 1} got no full answer`);
      return false;
    }
    this.#unanswered.delete(download.name);
    const viable = sources.filter((source) => !(source.cached === false && source.seeders === 0));
    const tried = new Set([
      ...download.tried,
      ...(download.wanted ? [] : [download.release.identity]),
    ]);
    const fresh = viable.filter((source) => !tried.has(source.identity));
    const chosen = this.queue.pick(fresh.length ? fresh : viable, download.title.originalLanguage);
    const at = await this.#stamp(now);
    const retries = { value: { int: attempt + 1 }, at };
    if (!chosen) {
      console.info(
        `den: download ${download.content}: search ${attempt + 1} found nothing to fetch (${sources.length} listed)`,
      );
      return this.#write(
        download,
        {
          exhausted: { value: { bool: true }, at },
          retries,
          candidates: { value: viable.length ? { int: viable.length } : null, at },
        },
        now,
      );
    }
    console.info(
      `den: download ${download.content}: search ${attempt + 1} found ${chosen.label}${
        chosen.cached ? ' (cached)' : ''
      }`,
    );
    return this.#start(
      download,
      chosen,
      {
        retries: attempt + 1,
        tried: fresh.length ? [...tried] : [],
        candidates: viable.length,
        queuedAt: now,
      },
      now,
    );
  }

  /**
   * A wanted download's release, started: the row then names it with its search count, what was tried, the candidates
   * and when the add was made, and the add is made (again, for one Hearth made: den-scout de-duplicates it).
   */
  async #start(
    download: Download,
    chosen: TitleSource,
    picked: { retries: number; tried: string[]; candidates: number; queuedAt: number },
    now: number,
  ): Promise<boolean> {
    const at = await this.#stamp(now);
    const values: Record<string, Stamped<ConfigValue | null>> = {
      retries: { value: { int: picked.retries }, at },
      release: {
        value: releaseValue({
          identity: chosen.identity,
          label: chosen.label,
          url: chosen.url,
          sizeBytes: chosen.size,
          cached: chosen.cached,
        }),
        at,
      },
      queuedAt: { value: { int: picked.queuedAt }, at },
      tried: { value: { strings: picked.tried }, at },
      candidates: { value: { int: picked.candidates }, at },
      exhausted: { value: { bool: false }, at },
      progress: { value: clockValue({ lastProgress: 0, progressAt: now }), at },
      reported: { value: { bool: false }, at },
      announced: { value: { bool: false }, at },
      reannounced: { value: { bool: false }, at },
      resumeAt: { value: null, at },
    };
    if (!(await this.#write(download, values, now))) return false;
    this.queue.clocks.delete(download.name);
    if (this.#stillHeld(now)) await this.queue.add(download.name, chosen.url);
    return true;
  }

  async #startHedge(download: Download, now: number): Promise<boolean> {
    if (!this.queue.hedgeResolveDue(download, now)) return false;
    const { sources, answer } = await this.queue.sourcesForTitle(download.title, true);
    if (!this.#stillHeld(now) || !sources) return false;
    const excluded = new Set([...download.tried, download.release.identity]);
    const candidates = sources.filter(
      (source) =>
        !excluded.has(source.identity) && !(source.cached === false && source.seeders === 0),
    );
    const chosen = this.queue.pick(candidates, download.title.originalLanguage);
    if (!chosen) {
      if (completeAnswer(answer)) this.queue.rememberNoHedge(download, now + NO_HEDGE_MS);
      return false;
    }
    const hedge: DownloadHedge = {
      identity: chosen.identity,
      label: chosen.label,
      url: chosen.url,
      sizeBytes: chosen.size,
      cached: chosen.cached,
      queuedAt: now,
      lastProgress: 0,
      progressAt: now,
    };
    const written = await this.#write(
      download,
      {
        release: {
          value: releaseValue({ ...download.release, hedge }),
          at: await this.#stamp(now),
        },
      },
      now,
    );
    if (written && this.#stillHeld(now))
      await this.queue.addHedge(download.name, chosen.url, chosen.identity);
    return written;
  }

  async #primaryWon(download: Download, now: number): Promise<boolean> {
    const written = await this.#write(
      download,
      {
        release: {
          value: releaseValue(primaryRelease(download)),
          at: await this.#stamp(now),
        },
      },
      now,
    );
    if (!written) return false;
    await this.queue.cancelHedgeIfSafe(download);
    this.queue.clearHedge(download.name);
    return true;
  }

  async #hedgeWon(download: Download, now: number): Promise<boolean> {
    const hedge = download.release.hedge;
    if (!hedge) return false;
    const at = await this.#stamp(now);
    const written = await this.#write(
      download,
      {
        release: {
          value: releaseValue({
            identity: hedge.identity,
            label: hedge.label ?? download.release.label,
            url: hedge.url,
            sizeBytes: hedge.sizeBytes,
            cached: hedge.cached,
          }),
          at,
        },
        queuedAt: { value: { int: hedge.queuedAt }, at },
        progress: { value: clockValue({ lastProgress: 1, progressAt: now }), at },
        announced: { value: { bool: false }, at },
        reannounced: { value: { bool: false }, at },
      },
      now,
    );
    if (!written) return false;
    await this.queue.cancelIfSafe(download);
    this.queue.promoteHedge(download);
    this.queue.clocks.delete(download.name);
    return true;
  }

  async #resumed(now: number) {
    const at = await this.#stamp(now);
    return {
      queuedAt: { value: { int: now }, at },
      progress: { value: clockValue({ lastProgress: 0, progressAt: now }), at },
      resumeAt: { value: null, at },
    } satisfies Record<string, Stamped<ConfigValue | null>>;
  }

  async #writeTicket(download: Download, now: number): Promise<boolean> {
    const url = this.queue.urls.get(download.name);
    this.queue.lapsed.delete(download.name);
    if (!url || url === download.release.url) return false;
    return this.#write(
      download,
      {
        release: {
          value: releaseValue({ ...download.release, url }),
          at: await this.#stamp(now),
        },
      },
      now,
    );
  }

  async #fallBack(download: Download, status: DownloadStatus, now: number): Promise<boolean> {
    const { sources, answer } = await this.queue.sourcesForTitle(download.title, true);
    if (!this.#stillHeld(now)) return false;
    const next = syncPolicy<{
      decision: 'next' | 'exhausted' | 'undecided';
      index?: number;
      candidates?: number;
      tried: string[];
    }>({
      op: 'download_next',
      row: download.row,
      releases: sources ? rankable(sources) : [],
      resolution: sources === null ? 'undecided' : sources.length ? 'streams' : 'none',
      complete: completeAnswer(answer),
    });
    if (next.decision === 'undecided') return false;
    const at = await this.#stamp(now);
    const values: Record<string, Stamped<ConfigValue | null>> = {
      tried: { value: { strings: next.tried }, at },
    };
    if (next.candidates !== undefined) values.candidates = { value: { int: next.candidates }, at };
    if (next.decision === 'exhausted') {
      values.exhausted = { value: { bool: true }, at };
      return this.#write(download, values, now);
    }
    const chosen = sources![next.index!]!;
    Object.assign(values, {
      release: {
        value: releaseValue({
          identity: chosen.identity,
          label: chosen.label,
          url: chosen.url,
          sizeBytes: chosen.size,
          cached: chosen.cached,
        }),
        at,
      },
      queuedAt: { value: { int: now }, at },
      progress: { value: clockValue({ lastProgress: 0, progressAt: now }), at },
      reported: { value: { bool: false }, at },
      announced: { value: { bool: false }, at },
      reannounced: { value: { bool: false }, at },
      resumeAt: { value: null, at },
    });
    if (!(await this.#write(download, values, now))) return false;
    await this.queue.cancelIfSafe(download);
    this.queue.clocks.delete(download.name);
    await this.queue.add(download.name, chosen.url);
    console.warn(
      `den: download ${download.content}: ${download.release.label} ${
        status.state === 'fetching' ? 'made no progress' : 'stalled'
      }; trying ${chosen.label}`,
    );
    return true;
  }
}

const completeAnswer = (answer: SourceAnswer | undefined): boolean =>
  !(
    answer?.kind === 'partial' ||
    answer?.kind === 'unknown' ||
    answer?.kind === 'stale' ||
    answer?.outage ||
    (answer?.missing ?? 0) > 0
  );

const primaryRelease = (download: Download) => ({
  identity: download.release.identity,
  label: download.release.label,
  url: download.release.url,
  sizeBytes: download.release.sizeBytes,
  cached: download.release.cached,
});
