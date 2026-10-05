// The download queue's one driver (den-spec library-v4 §17 *The lease*): whichever device holds `set:download-lease`
// moves a stalled download on to its next release, writes the coarse stall clock, the "reported" and "announced"
// marks and renewed tickets, and prunes. Every open client polls what it shows; only the holder writes those, each by
// compare-and-set on the row as it read it, and a write that conflicts is dropped and decided again next pass.

import {
  FOREIGN,
  GONE,
  inFlight,
  pollDelay,
  type DownloadQueue,
  type DownloadState,
} from './downloadQueue.svelte';
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
import { applyLog, contentWatched, emptyLibrary } from './library';
import type { LibraryLog } from './log';
import { syncPolicy } from './syncCore';
import { rankable } from './titleSources';
import type { ConfigValue, SettingsRow, Stamped } from './wire';

const pageStartedAt = Date.now();
const pageStartedMono = globalThis.performance?.now() ?? 0;
/** How many probes are in flight at once: a season shouldn't be a burst of two dozen. */
const CONCURRENCY = 4;
/** The holder den-core is told of for a lease row naming this device that another window of it took. */
const ANOTHER_WINDOW = 'another-window';

/** This page's hold on the lease: its epoch, and when its take or renewal was sent, on both clocks. */
interface Held {
  epoch: number;
  at: number;
  mono: number;
}
const held = new WeakMap<LibraryLog, Held>();
/** When this page first saw the lease row at its current seq: the observation a take waits on. */
const observed = new WeakMap<LibraryLog, { seq: number; at: number; mono: number }>();

/** Time since `at`, by the greater of the wall clock and the monotonic one; a wall clock that ran back is expiry. */
function since(at: number, mono: number, now: number): number | undefined {
  const wall = now - at;
  if (wall < 0) return undefined;
  return Math.max(wall, (globalThis.performance?.now() ?? mono) - mono);
}

export interface DriveOptions {
  now?: number;
  /** How long this page has been open: a take needs ten minutes of observing the lease unchanged (v3 §6). */
  observedFor?: number;
}

/**
 * One pass: poll what is in flight, then, while this page holds the lease, act on what the answers say. True when
 * the pass wrote anything.
 */
export async function driveDownloads(
  log: LibraryLog,
  queue: DownloadQueue,
  device: string,
  options: DriveOptions = {},
): Promise<boolean> {
  const now = options.now ?? Date.now();
  const all = queue.list();
  const polled = all.filter((d) => {
    const state = queue.status(d, now).state;
    // A held-back add is made again by the holder at its time; until then there is nothing to ask.
    if (state === 'no_working_release' || state === 'release_gone' || state === 'paused')
      return false;
    return due(queue, d, now);
  });
  for (let i = 0; i < polled.length; i += CONCURRENCY)
    await Promise.all(
      polled.slice(i, i + CONCURRENCY).map(async (d) => {
        await pollAndRenew(queue, d);
        asked(queue, d, now);
      }),
    );
  queue.touch();
  if (!all.length || !(await holdLease(log, device, now, options.observedFor))) return false;
  return holderPass(log, queue, device, now);
}

/** Per download, when this page last asked and how many asks in a row changed nothing (`pollDelay`). */
const asks = new WeakMap<DownloadQueue, Map<string, { at: number; quiet: number; said: string }>>();

/** Whether a download is due another ask: `pollDelay` after the last, longer the longer its answers stay the same. */
function due(queue: DownloadQueue, download: Download, now: number): boolean {
  const last = asks.get(queue)?.get(download.name);
  return !last || now - last.at >= pollDelay(last.quiet);
}

function asked(queue: DownloadQueue, download: Download, now: number): void {
  let seen = asks.get(queue);
  if (!seen) asks.set(queue, (seen = new Map()));
  const said = JSON.stringify([
    queue.answers.get(download.name) ?? null,
    queue.hedgeAnswers.get(download.name) ?? null,
  ]);
  const last = seen.get(download.name);
  seen.set(download.name, {
    at: now,
    quiet: last && last.said === said ? last.quiet + 1 : 0,
    said,
  });
}

/**
 * Ask about one download, and when its ticket is one this browser can't use — lapsed, or another device's — find the
 * same release again and ask with that. Every client renews for itself (§17 *Play tickets*).
 */
async function pollAndRenew(queue: DownloadQueue, download: Download): Promise<void> {
  const answer = await queue.poll(download);
  if (download.release.hedge) await queue.pollHedge(download);
  if (answer.state !== 'expired' || answer.message === GONE) return;
  const url = await queue.renew(download);
  if (typeof url !== 'string') return;
  if (answer.message !== FOREIGN) queue.lapsed.add(download.name);
  await queue.poll(download);
}

/**
 * Take, renew or keep the lease, as den-core's `lease` decides, by compare-and-set on the lease row. True while this
 * page holds it.
 */
export async function holdLease(
  log: LibraryLog,
  device: string,
  now = Date.now(),
  observedFor = Math.max(
    Date.now() - pageStartedAt,
    (globalThis.performance?.now() ?? 0) - pageStartedMono,
  ),
): Promise<boolean> {
  const name = `set:${LEASE_ROW}`;
  const row = log.settings(LEASE_ROW);
  const seq = log.seqOf(name);
  const value = row?.values.lease?.value;
  const [holder = '', epochText = '0'] = value && 'strings' in value ? value.strings : [];
  const epoch = Number(epochText) || 0;
  const mine = held.get(log);
  const mono = globalThis.performance?.now() ?? 0;
  const seen = observed.get(log);
  if (!seen || seen.seq !== seq) observed.set(log, { seq, at: now, mono });
  const watched = seen && seen.seq === seq ? (since(seen.at, seen.mono, now) ?? 0) : 0;
  // Every window of this browser shares its device id. A row naming it that this page never took is another
  // window's, or one closed since: watched like any other holder's and taken only once it has stayed unchanged ten
  // minutes (v3 §6 *Taking*, as the SIMKL driver does). Taken at once, two windows would take it from each other on
  // every pass, and both act as holder.
  const ours = holder === device && mine?.epoch === epoch;
  const decision = syncPolicy<{ action: string; epoch?: number }>({
    op: 'lease',
    input: {
      device,
      holder: ours ? device : holder === device ? ANOTHER_WINDOW : holder,
      epoch,
      elapsed: ours ? since(mine.at, mine.mono, now) : undefined,
      observed: Math.max(watched, holder ? 0 : observedFor),
      fresh_generation: false,
    },
  });
  if (decision.action === 'send') return true;
  if (decision.action !== 'take' && decision.action !== 'renew') {
    if (decision.action === 'stop') held.delete(log);
    return false;
  }
  const next = decision.epoch ?? epoch + 1;
  const base: SettingsRow = row ?? emptyRow(LEASE_ROW);
  const stamp = syncPolicy<[number, number, string]>({
    op: 'issue',
    last: log.newestStamp(),
    now,
    device,
  });
  const leased: SettingsRow = {
    ...base,
    values: { ...base.values, lease: { value: { strings: [device, String(next)] }, at: stamp } },
  };
  if (!(await log.writeAt(leased, seq))) {
    held.delete(log);
    return false;
  }
  held.set(log, { epoch: next, at: now, mono });
  observed.set(log, { seq: log.seqOf(name), at: now, mono });
  return true;
}

/**
 * Whether this page still holds the lease, checked again immediately before every holder write: its take or renewal
 * is under 120 s old, and the lease row as last read still names this device at the epoch this page took.
 */
export function stillHeld(log: LibraryLog, device: string, now: number): boolean {
  const mine = held.get(log);
  const elapsed = mine ? since(mine.at, mine.mono, now) : undefined;
  if (!mine || elapsed === undefined || elapsed >= 120_000) return false;
  const value = log.settings(LEASE_ROW)?.values.lease?.value;
  const [holder, epoch] = value && 'strings' in value ? value.strings : [];
  return holder === device && Number(epoch) === mine.epoch;
}

/**
 * A holder write: compare-and-set on the seq the row was read at when the pass decided it. Another device's write in
 * between is a conflict; the write is dropped, and the row decided again next pass on what it then says.
 */
async function write(
  log: LibraryLog,
  device: string,
  download: Download,
  values: Record<string, Stamped<ConfigValue | null>>,
  now: number,
): Promise<boolean> {
  if (!stillHeld(log, device, now)) return false;
  return log.writeAt(withValues(download.row, values), download.seq);
}

async function holderPass(
  log: LibraryLog,
  queue: DownloadQueue,
  device: string,
  now: number,
): Promise<boolean> {
  let wrote = false;
  const states: Record<string, string> = {};
  const stamp = () =>
    syncPolicy<[number, number, string]>({ op: 'issue', last: log.newestStamp(), now, device });
  // Every decision below is made on these rows, at these seqs: a holder write compare-and-sets on the seq of the row
  // it decided on, never one read after another write.
  const decided = queue.list();
  for (const download of decided) {
    const status = queue.status(download, now);
    if (status.state) states[download.name] = status.state;
    queue.clocks.set(download.name, status.clock);
    if (download.exhausted) continue;
    if (download.release.hedge) {
      // Prefer the work the viewer already had: if both finish in one polling pass, the primary wins.
      if (status.state === 'ready') {
        wrote = (await primaryWon(log, device, queue, download, now, stamp)) || wrote;
        continue;
      }
      const alternate = queue.hedgeAnswers.get(download.name);
      if (alternate?.state === 'ready') {
        wrote = (await hedgeWon(log, device, queue, download, now, stamp)) || wrote;
        continue;
      }
      if (
        alternate?.state === 'preparing' &&
        alternate.progress !== undefined &&
        alternate.progress > (download.release.hedge.lastProgress ?? 0)
      ) {
        const hedge = {
          ...download.release.hedge,
          lastProgress: alternate.progress,
          progressAt: now,
        };
        wrote =
          (await write(
            log,
            device,
            download,
            { release: { value: releaseValue({ ...download.release, hedge }), at: stamp() } },
            now,
          )) || wrote;
        continue;
      }
    }
    // A held-back add whose time has come is made again, with a fresh queue time.
    if (
      status.state === 'starting' &&
      download.resumeAt !== undefined &&
      download.resumeAt <= now
    ) {
      const url = queue.urlFor(download);
      if (url && (await write(log, device, download, resumed(stamp(), now), now))) {
        wrote = true;
        await queue.add(download.name, url);
      }
      continue;
    }
    if (queue.lapsed.has(download.name)) {
      wrote = (await writeTicket(log, device, queue, download, now, stamp)) || wrote;
      continue;
    }
    // A ticket still to renew says nothing about the fetch.
    if (status.renew) continue;
    if (status.stalled) {
      const answer = queue.answers.get(download.name);
      const progress =
        answer?.progress ?? download.progress?.lastProgress ?? status.clock.lastProgress;
      if (!download.release.hedge && answer?.fetch?.state !== 'failed' && progress > 0)
        wrote = (await startHedge(log, device, queue, download, now, stamp)) || wrote;
      else if (!download.release.hedge)
        wrote = (await fallBack(log, device, queue, download, status, now, stamp)) || wrote;
      continue;
    }
    const values: Record<string, Stamped<ConfigValue | null>> = {};
    const at = stamp();
    if (status.report) values.reported = { value: { bool: true }, at };
    if (status.announce) values.announced = { value: { bool: true }, at };
    if (status.write_progress) values.progress = { value: clockValue(status.clock), at };
    if (status.reannounce) values.reannounced = { value: { bool: true }, at };
    if (!Object.keys(values).length) continue;
    const written = await write(log, device, download, values, now);
    wrote = written || wrote;
    // Sent once `reannounced` is down: a write that conflicted is decided again next pass, and sends then.
    const url = status.reannounce && written ? queue.urlFor(download) : undefined;
    if (url) await queue.cancelRelease(url, true);
  }
  // The row's own episode or film watched, never the series' standing (den-spec library-v4 §17 *Pruning*): a
  // series finished last season must not prune this season's downloads before anyone has watched them.
  const library = applyLog(emptyLibrary(), log.rows());
  const watched: Record<string, boolean> = {};
  for (const d of decided)
    if (
      contentWatched(library, {
        type: d.title.mediaType,
        id: d.title.mediaId,
        season: d.title.season,
        episode: d.title.episode,
      })
    )
      watched[d.name] = true;
  const pruned = syncPolicy<{ remove: string[] }>({
    op: 'download_prune',
    rows: decided.map((d) => d.row),
    states,
    watched,
    now,
  });
  const byName = new Map(decided.map((d) => [d.name, d]));
  for (const name of pruned.remove) {
    const download = byName.get(name);
    if (!download || !stillHeld(log, device, now)) continue;
    // On the row and seq the decision read: one another device restarted since is a conflict, and stays.
    wrote = (await log.writeAt(removedRow(download.row, stamp()), download.seq)) || wrote;
  }
  if (wrote) queue.touch();
  return wrote;
}

/** The release object without its temporary alternate. */
function primaryRelease(download: Download) {
  return {
    identity: download.release.identity,
    label: download.release.label,
    url: download.release.url,
    sizeBytes: download.release.sizeBytes,
    cached: download.release.cached,
  };
}

/** A partial primary stalled: preserve it and queue one ranked, untried alternate beside it. */
async function startHedge(
  log: LibraryLog,
  device: string,
  queue: DownloadQueue,
  download: Download,
  now: number,
  stamp: () => [number, number, string],
): Promise<boolean> {
  if (!queue.resolve) return false;
  const { sources } = await queue.resolve(download.title);
  if (!sources) return false;
  const excluded = new Set([...download.tried, download.release.identity]);
  const candidates = sources.filter(
    (source) =>
      !excluded.has(source.identity) && !(source.cached === false && source.seeders === 0),
  );
  const chosen = queue.pick(candidates, download.title.originalLanguage);
  if (!chosen) return false;
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
  const written = await write(
    log,
    device,
    download,
    { release: { value: releaseValue({ ...download.release, hedge }), at: stamp() } },
    now,
  );
  if (!written) return false;
  console.warn(
    `den: download ${download.content}: keeping ${download.release.label} and trying ${chosen.label} beside it`,
  );
  await queue.addHedge(download.name, chosen.url);
  return true;
}

/** The preserved primary recovered first: forget and safely cancel only its alternate. */
async function primaryWon(
  log: LibraryLog,
  device: string,
  queue: DownloadQueue,
  download: Download,
  now: number,
  stamp: () => [number, number, string],
): Promise<boolean> {
  const written = await write(
    log,
    device,
    download,
    { release: { value: releaseValue(primaryRelease(download)), at: stamp() } },
    now,
  );
  if (!written) return false;
  await queue.cancelHedgeIfSafe(download);
  queue.clearHedge(download.name);
  return true;
}

/** The alternate finished first: promote it atomically, then safely cancel only the partial loser. */
async function hedgeWon(
  log: LibraryLog,
  device: string,
  queue: DownloadQueue,
  download: Download,
  now: number,
  stamp: () => [number, number, string],
): Promise<boolean> {
  const hedge = download.release.hedge;
  if (!hedge) return false;
  const at = stamp();
  const written = await write(
    log,
    device,
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
  await queue.cancelIfSafe(download);
  queue.promoteHedge(download);
  queue.clocks.delete(download.name);
  return true;
}

/** The values a resumed add writes: its queue time and stall clock start again, and the appointment is kept no more. */
function resumed(at: [number, number, string], now: number) {
  return {
    queuedAt: { value: { int: now }, at },
    progress: { value: clockValue({ lastProgress: 0, progressAt: now }), at },
    resumeAt: { value: null, at },
  } satisfies Record<string, Stamped<ConfigValue | null>>;
}

/** A lapsed ticket this page renewed: the fresh one written to the row, so a relaunch asks with it. */
async function writeTicket(
  log: LibraryLog,
  device: string,
  queue: DownloadQueue,
  download: Download,
  now: number,
  stamp: () => [number, number, string],
): Promise<boolean> {
  const url = queue.urls.get(download.name);
  queue.lapsed.delete(download.name);
  if (!url || url === download.release.url) return false;
  return write(
    log,
    device,
    download,
    { release: { value: releaseValue({ ...download.release, url }), at: stamp() } },
    now,
  );
}

/**
 * Give up on a stalled release and move on to the next (`download_next`): cancel it at the debrid unless a sibling
 * still needs it, write the next release with a fresh queue time and stall clock, then ask scout to fetch it.
 */
async function fallBack(
  log: LibraryLog,
  device: string,
  queue: DownloadQueue,
  download: Download,
  status: DownloadState,
  now: number,
  stamp: () => [number, number, string],
): Promise<boolean> {
  if (!queue.resolve) return false;
  const { sources, answer } = await queue.resolve(download.title);
  const complete = !(
    answer?.kind === 'partial' ||
    answer?.kind === 'unknown' ||
    (answer?.missing ?? 0) > 0
  );
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
    complete,
  });
  if (next.decision === 'undecided') return false;
  const at = stamp();
  const values: Record<string, Stamped<ConfigValue | null>> = {
    tried: { value: { strings: next.tried }, at },
  };
  if (next.candidates !== undefined) values.candidates = { value: { int: next.candidates }, at };
  if (next.decision === 'exhausted') {
    values.exhausted = { value: { bool: true }, at };
    return write(log, device, download, values, now);
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
  console.warn(
    `den: download ${download.content}: ${download.release.label} ${
      status.state === 'fetching' ? 'made no progress' : 'stalled'
    }; trying ${chosen.label}`,
  );
  if (!(await write(log, device, download, values, now))) return false;
  // Only once the row names the next release: a write dropped above leaves the stalled one where it was.
  await queue.cancelIfSafe(download);
  queue.clocks.delete(download.name);
  await queue.add(download.name, chosen.url);
  return true;
}

/** Whether any download is in flight: what puts the Downloads row on Home. */
export const anyInFlight = (queue: DownloadQueue, now = Date.now()) =>
  queue.list().some((d) => inFlight(queue.status(d, now).state));
