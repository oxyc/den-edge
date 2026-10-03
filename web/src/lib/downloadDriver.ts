// The download queue's one driver (den-spec library-v4 §17 *The lease*): whichever device holds `set:download-lease`
// moves a stalled download on to its next release, writes the coarse stall clock, the "reported" and "announced"
// marks and renewed tickets, and prunes. Every open client polls what it shows; only the holder writes those, each by
// compare-and-set on the row as it read it, and a write that conflicts is dropped and decided again next pass.

import {
  FOREIGN,
  GONE,
  inFlight,
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
} from './downloadRows';
import type { LibraryLog } from './log';
import { syncPolicy } from './syncCore';
import { rankable } from './titleSources';
import type { ConfigValue, SettingsRow, Stamped } from './wire';

const pageStartedAt = Date.now();
const pageStartedMono = globalThis.performance?.now() ?? 0;
/** How many probes are in flight at once: a season shouldn't be a burst of two dozen. */
const CONCURRENCY = 4;

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
    return state !== 'no_working_release' && state !== 'release_gone' && state !== 'paused';
  });
  for (let i = 0; i < polled.length; i += CONCURRENCY)
    await Promise.all(polled.slice(i, i + CONCURRENCY).map((d) => pollAndRenew(queue, d)));
  queue.touch();
  if (!all.length || !(await holdLease(log, device, now, options.observedFor))) return false;
  return holderPass(log, queue, device, now);
}

/**
 * Ask about one download, and when its ticket is one this browser can't use — lapsed, or another device's — find the
 * same release again and ask with that. Every client renews for itself (§17 *Play tickets*).
 */
async function pollAndRenew(queue: DownloadQueue, download: Download): Promise<void> {
  const answer = await queue.poll(download);
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
  // A row naming this device that this page never took is a lease from an earlier visit: taken again, by CAS.
  const ours = holder === device && mine?.epoch === epoch;
  const decision = syncPolicy<{ action: string; epoch?: number }>({
    op: 'lease',
    input: {
      device,
      holder: ours ? device : holder === device ? '' : holder,
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

/** Whether this page still holds the lease: checked again immediately before every holder write. */
function stillHeld(log: LibraryLog, now: number): boolean {
  const mine = held.get(log);
  const elapsed = mine ? since(mine.at, mine.mono, now) : undefined;
  return elapsed !== undefined && elapsed < 120_000;
}

/**
 * A holder write: compare-and-set on the seq the row was read at when the pass decided it. Another device's write in
 * between is a conflict; the write is dropped, and the row decided again next pass on what it then says.
 */
async function write(
  log: LibraryLog,
  download: Download,
  values: Record<string, Stamped<ConfigValue | null>>,
  now: number,
): Promise<boolean> {
  if (!stillHeld(log, now)) return false;
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
  for (const download of queue.list()) {
    const status = queue.status(download, now);
    if (status.state) states[download.name] = status.state;
    queue.clocks.set(download.name, status.clock);
    if (download.exhausted) continue;
    // A held-back add whose time has come is made again, with a fresh queue time.
    if (
      status.state === 'starting' &&
      download.resumeAt !== undefined &&
      download.resumeAt <= now
    ) {
      const url = queue.urlFor(download);
      if (url && (await write(log, download, resumed(stamp(), now), now))) {
        wrote = true;
        await queue.add(download.name, url);
      }
      continue;
    }
    if (queue.lapsed.has(download.name)) {
      wrote = (await writeTicket(log, queue, download, now, stamp)) || wrote;
      continue;
    }
    // A ticket still to renew says nothing about the fetch.
    if (status.renew) continue;
    if (status.stalled) {
      wrote = (await fallBack(log, queue, download, status, now, stamp)) || wrote;
      continue;
    }
    const values: Record<string, Stamped<ConfigValue | null>> = {};
    const at = stamp();
    if (status.report) values.reported = { value: { bool: true }, at };
    if (status.announce) values.announced = { value: { bool: true }, at };
    if (status.write_progress) values.progress = { value: clockValue(status.clock), at };
    if (status.reannounce) {
      const url = queue.urlFor(download);
      if (url) await queue.cancelRelease(url, true);
      values.reannounced = { value: { bool: true }, at };
    }
    if (Object.keys(values).length) wrote = (await write(log, download, values, now)) || wrote;
  }
  const pruned = syncPolicy<{ remove: string[] }>({
    op: 'download_prune',
    rows: queue.list().map((d) => d.row),
    states,
    now,
  });
  for (const name of pruned.remove) {
    const row = log.settings(name);
    if (!row || !stillHeld(log, now)) continue;
    wrote = (await log.writeAt(removedRow(row, stamp()), log.seqOf(`set:${name}`))) || wrote;
  }
  if (wrote) queue.touch();
  return wrote;
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
    return write(log, download, values, now);
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
  if (!(await write(log, download, values, now))) return false;
  // Only once the row names the next release: a write dropped above leaves the stalled one where it was.
  await queue.cancelIfSafe(download);
  queue.clocks.delete(download.name);
  await queue.add(download.name, chosen.url);
  return true;
}

/** Whether any download is in flight: what puts the Downloads row on Home. */
export const anyInFlight = (queue: DownloadQueue, now = Date.now()) =>
  queue.list().some((d) => inFlight(queue.status(d, now).state));
