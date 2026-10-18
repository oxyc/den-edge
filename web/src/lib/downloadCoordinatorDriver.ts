import {
  downloadPollDelay,
  raceKey,
  type DownloadCoordinator,
  type DownloadStatus,
} from './downloadCoordinator';
import {
  clearedRace,
  clockValue,
  emptyRow,
  LEASE_ROW,
  raceValue,
  releaseValue,
  removedRow,
  withValues,
  type Download,
  type DownloadRace,
  type DownloadRaceEntry,
} from './downloadRows';
import { wantedItems, type WantedStatus } from './hearthWanted';
import { applyLog, contentWatched, emptyLibrary } from './library';
import { syncPolicy } from './syncCore';
import { answerOf, rankable, type SourceAnswer, type TitleSource } from './titleSources';
import type { ConfigValue, SettingsRow, Stamped, Stamp } from './wire';

const CONCURRENCY = 4;
/** How long a race decides on one resolve of the title's releases: its stages are hours apart. */
const RACE_LIST_MS = 10 * 60_000;

/** den-core's `download_escalate` (den-spec library-v4 §17 *Racing*). */
interface Escalation {
  decision: 'take' | 'add' | 'wait' | 'exhausted';
  take?: string;
  reason?: 'finished' | 'cached' | 'fallback';
  add: string[];
  cancel: string[];
  stage: number;
  stage_at: number;
  capped: boolean;
}
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
  /** By row name: the releases a race last decided on, and when they were resolved. */
  readonly #raceLists = new Map<string, { at: number; sources: TitleSource[] }>();

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
            ...download.race.entries.map(
              (entry) =>
                this.queue.entryAnswers.get(raceKey(download.name, entry.identity)) ?? null,
            ),
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
    for (const entry of download.race.entries) {
      if (!current()) return;
      await this.queue.pollEntry(download, entry);
    }
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
      for (const entry of download.race.entries) {
        // An entry whose add never landed (a relaunch, another device's ticket) is asked for again.
        const answer = this.queue.entryAnswers.get(raceKey(download.name, entry.identity));
        const url = answer?.state === 'not-queued' ? this.queue.entryUrl(download, entry) : null;
        if (url && current() && this.#stillHeld(now))
          await this.queue.addEntry(download.name, entry.identity, url);
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
      if (status.state === 'release_gone' && !download.race.entries.length) {
        wrote = (await this.#fallBack(download, status, now)) || wrote;
        continue;
      }
      if (status.renew) continue;
      // The race (§17 *Racing*): keep what finishes first, widen a race that isn't arriving, fall back after a day.
      const raced = await this.#race(download, status, now);
      if (raced !== 'unchanged') {
        wrote = raced === 'written' || wrote;
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

  /** The releases a race decides on: one resolve per `RACE_LIST_MS`; null while none could be had. */
  async #raceList(download: Download, now: number): Promise<TitleSource[] | null> {
    const kept = this.#raceLists.get(download.name);
    if (kept && now - kept.at < RACE_LIST_MS) return kept.sources;
    const { sources, answer } = await this.queue.sourcesForTitle(download.title, true);
    if (!sources || !completeAnswer(answer)) return kept?.sources ?? null;
    this.#raceLists.set(download.name, { at: now, sources });
    return sources;
  }

  /**
   * One pass of the row's race through den-core's `download_escalate`: what is in flight (the `release` and every
   * `race` entry, with den-scout's latest word on each) against the releases listed now. `unchanged` when it decided
   * nothing to write, `written` when the row changed, `failed` when a write lost its compare-and-set.
   */
  async #race(
    download: Download,
    status: DownloadStatus,
    now: number,
  ): Promise<'unchanged' | 'written' | 'failed'> {
    const { race, name } = download;
    const entries = race.entries;
    if (status.state === 'paused' || (status.state === 'ready' && !entries.length))
      return 'unchanged';
    const primary = this.queue.answers.get(name);
    const flights = [
      {
        identity: download.release.identity,
        since: download.queuedAt,
        stalled: status.stalled,
        ...(status.state === 'release_gone'
          ? { answer: { kind: 'dead' } }
          : primary
            ? { answer: answerOf(primary) }
            : {}),
      },
      ...entries.map((entry) => {
        const answer = this.queue.entryAnswers.get(raceKey(name, entry.identity));
        return {
          identity: entry.identity,
          since: entry.queuedAt,
          ...(answer ? { answer: answerOf(answer) } : {}),
        };
      }),
    ];
    const decide = (releases: TitleSource[]) =>
      syncPolicy<Escalation>({
        op: 'download_escalate',
        releases: rankable(releases),
        original: download.title.originalLanguage,
        preferred: download.title.preferredLanguage,
        tried: download.tried,
        in_flight: flights,
        stage: race.stage,
        stage_at: race.stageAt,
        started_at: race.startedAt,
        ...(race.cappedAt !== undefined ? { capped_at: race.cappedAt } : {}),
        now,
      });
    // Until a race is under way a healthy download costs den-scout no list: den-core is asked first with the
    // releases last resolved (or none), and the title is resolved only when that answer escalates.
    const first = decide(this.#raceLists.get(name)?.sources ?? []);
    const finished = first.decision === 'take' && first.reason === 'finished';
    const underWay = race.stage > 0 || entries.length > 0 || first.stage !== race.stage;
    if (!underWay && (first.decision === 'wait' || finished)) return 'unchanged';
    const listed = await this.#raceList(download, now);
    if (!this.#stillHeld(now)) return 'unchanged';
    const decided = listed ? decide(listed) : first;
    // Without a list only a finished release may be decided: nothing else can be judged.
    if (!listed && !(decided.decision === 'take' && decided.reason === 'finished'))
      return 'unchanged';
    if (decided.decision === 'take') return this.#take(download, decided, listed ?? [], now);
    return this.#widen(download, decided, listed ?? [], now);
  }

  /** The race is won: `take` becomes the release, and everything else in flight is cancelled where safe. */
  async #take(
    download: Download,
    decided: Escalation,
    listed: TitleSource[],
    now: number,
  ): Promise<'unchanged' | 'written' | 'failed'> {
    const identity = decided.take!;
    const entries = download.race.entries;
    const entry = entries.find((candidate) => candidate.identity === identity);
    const source = listed.find((candidate) => candidate.identity === identity);
    const isPrimary = identity === download.release.identity;
    if (isPrimary && !entries.length) return 'unchanged';
    if (!isPrimary && !entry && !source) return 'unchanged';
    const at = await this.#stamp(now);
    const values: Record<string, Stamped<ConfigValue | null>> = {
      race: { value: raceValue(clearedRace(download.race, now)), at },
    };
    if (!isPrimary) {
      const taken = entry ?? {
        identity,
        label: source!.label,
        url: source!.url,
        sizeBytes: source!.size,
        cached: source!.cached,
        queuedAt: now,
      };
      Object.assign(values, {
        release: {
          value: releaseValue({
            identity,
            label: taken.label ?? identity,
            url: taken.url,
            sizeBytes: taken.sizeBytes,
            cached: taken.cached,
          }),
          at,
        },
        queuedAt: { value: { int: taken.queuedAt }, at },
        progress: {
          value: clockValue({ lastProgress: entry ? 1 : 0, progressAt: now }),
          at,
        },
        announced: { value: { bool: false }, at },
        reannounced: { value: { bool: false }, at },
        resumeAt: { value: null, at },
      });
    }
    if (!(await this.#write(download, values, now))) return 'failed';
    console.info(
      `den: download ${download.content}: kept ${entry?.label ?? source?.label ?? download.release.label} (${decided.reason})`,
    );
    for (const other of entries)
      if (other.identity !== identity)
        await this.queue.cancelEntryIfSafe(
          download,
          other.identity,
          this.queue.entryUrl(download, other),
        );
    if (!isPrimary) await this.queue.cancelIfSafe(download);
    if (entry) this.queue.promoteEntry(download, entry);
    this.queue.clearEntries(download.name);
    this.queue.clocks.delete(download.name);
    if (!isPrimary && !entry && source) await this.queue.add(download.name, source.url);
    return 'written';
  }

  /**
   * The race goes on: drop what failed (it counts as tried), add what den-core says up to the stage's width, and stop
   * at the debrid's first refusal — its active-download limit, a cap and never a failure. A primary that failed hands
   * over to the first live entry. Nothing in flight and nothing to add is an exhausted download, searched for again.
   */
  async #widen(
    download: Download,
    decided: Escalation,
    listed: TitleSource[],
    now: number,
  ): Promise<'unchanged' | 'written' | 'failed'> {
    const { race } = download;
    const dropped = new Set(decided.cancel);
    let entries: DownloadRaceEntry[] = race.entries.filter((entry) => !dropped.has(entry.identity));
    let cappedAt = race.cappedAt;
    const added: DownloadRaceEntry[] = [];
    for (const identity of decided.add) {
      const source = listed.find((candidate) => candidate.identity === identity);
      if (!source || !this.#stillHeld(now)) continue;
      const answer = await this.queue.addEntry(download.name, identity, source.url);
      if (answer.state === 'refused') {
        cappedAt = now;
        this.queue.forgetEntry(download.name, identity);
        break;
      }
      added.push({
        identity,
        label: source.label,
        url: source.url,
        sizeBytes: source.size,
        cached: source.cached,
        queuedAt: now,
      });
    }
    entries = [...entries, ...added];
    const primaryFailed = dropped.has(download.release.identity);
    const promoted = primaryFailed ? entries[0] : undefined;
    if (promoted) entries = entries.slice(1);
    const next: DownloadRace = {
      stage: decided.stage,
      stageAt: decided.stage_at,
      startedAt: race.startedAt,
      ...(cappedAt !== undefined ? { cappedAt } : {}),
      entries,
    };
    const tried = [...new Set([...download.tried, ...decided.cancel])];
    const exhausted = decided.decision === 'exhausted';
    if (
      !exhausted &&
      !promoted &&
      JSON.stringify(raceValue(next)) === JSON.stringify(raceValue(race)) &&
      tried.length === download.tried.length
    )
      return 'unchanged';
    const at = await this.#stamp(now);
    const values: Record<string, Stamped<ConfigValue | null>> = {
      race: { value: raceValue(exhausted ? clearedRace(race, now) : next), at },
      tried: { value: { strings: tried }, at },
    };
    if (exhausted) values.exhausted = { value: { bool: true }, at };
    if (promoted)
      Object.assign(values, {
        release: {
          value: releaseValue({
            identity: promoted.identity,
            label: promoted.label ?? promoted.identity,
            url: promoted.url,
            sizeBytes: promoted.sizeBytes,
            cached: promoted.cached,
          }),
          at,
        },
        queuedAt: { value: { int: promoted.queuedAt }, at },
        progress: { value: clockValue({ lastProgress: 0, progressAt: now }), at },
        reported: { value: { bool: false }, at },
        announced: { value: { bool: false }, at },
        reannounced: { value: { bool: false }, at },
      });
    if (!(await this.#write(download, values, now))) {
      for (const entry of added)
        await this.queue.effects.cancel(this.queue.entryUrl(download, entry) ?? entry.url, false);
      return 'failed';
    }
    if (added.length)
      console.info(
        `den: download ${download.content}: racing ${added.map((entry) => entry.label).join(', ')} (stage ${decided.stage})`,
      );
    for (const identity of decided.cancel) {
      if (identity === download.release.identity) await this.queue.cancelIfSafe(download);
      else {
        const entry = race.entries.find((candidate) => candidate.identity === identity);
        if (entry)
          await this.queue.cancelEntryIfSafe(
            download,
            identity,
            this.queue.entryUrl(download, entry),
          );
      }
      this.queue.forgetEntry(download.name, identity);
    }
    if (promoted) {
      this.queue.promoteEntry(download, promoted);
      this.queue.clocks.delete(download.name);
    }
    return 'written';
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
