// What a browser saw while playing a den-remux session — how its segments arrived, where playback stalled and how
// much of each track was buffered then, what it dropped and what went wrong — posted to the session's `/report` for
// den-remux's log. The server sees requests only: whether a frozen picture was a slow link or a hole in the video
// buffer is visible from here and nowhere else. Shared by the player and the cast page's own player.

import type Hls from 'hls.js';

export const MAX_STALLS = 20;
export const MAX_ERRORS = 20;
/** den-remux reads a report body of up to 16 KB; this stays well inside it. */
export const MAX_REPORT_BYTES = 8 * 1024;
/** While stalls keep coming, a report goes at most this often. */
export const REPORT_INTERVAL_MS = 30_000;
/** den-remux logs at most this many reports for a session; the last is kept for the end. */
export const MAX_REPORTS = 3;
/**
 * Seconds the clock may run on with no new video frame before the picture counts as frozen. Above the ~2 s batches in
 * which iOS Safari's native player moves `totalVideoFrames`: at 1.5 s every batch read as a 0.5 s frozen stall, every
 * 2 s, while the picture played on.
 */
export const FROZEN_SECS = 3;
/** Video seconds ahead below which a player that fetches nothing is counted as idling on a low buffer. */
export const LOW_BUFFER_SECS = 10;
/** hls.js's own names for playback stopping on the buffer, or jumping a hole in it. */
const STALL_DETAILS = new Set(['bufferStalledError', 'bufferSeekOverHole', 'bufferNudgeOnStall']);

/** Why a report went: the first stall (and later ones, spaced out), the page hidden, or the session over. */
export type ReportEvent = 'stall' | 'hidden' | 'end';

export interface Stall {
  /** Media seconds where playback stopped. */
  at: number;
  /** How long until it played again; null when it hadn't by the time of the report. */
  ms: number | null;
  /** `wait`: the element waited for data. `frozen`: the clock (the audio) ran on, and no new video frame came. */
  kind: 'wait' | 'frozen';
  /** Seconds buffered ahead of the play head in each track, then (`PlaybackStats.buffers` says how measured). */
  videoAhead: number | null;
  audioAhead: number | null;
  /**
   * Whether a fragment was being fetched when playback stopped: a request under way is a slow delivery, none is a
   * player that had stopped asking. Null where the page can't see requests (the native player).
   */
  loading: boolean | null;
  /** With nothing being fetched, how long since the last fragment arrived; null otherwise. */
  idleMs: number | null;
}

export interface PlaybackStats {
  event: ReportEvent;
  /** Browser and OS, never the whole user agent: `Chrome 141 / Windows`. */
  browser: string;
  engine: 'hls.js' | 'native';
  /**
   * `separate`: `videoAhead` and `audioAhead` were read from hls.js's own video and audio SourceBuffers. `combined`:
   * there was no such pair (the native player, or muxed audio and video in one SourceBuffer), and both carry the
   * element's `buffered`, which is where all its tracks overlap.
   */
  buffers: 'separate' | 'combined';
  fragments: {
    count: number;
    bytes: number;
    /** Request to last byte, summed over every fragment. */
    loadMs: number;
    slowestMs: number;
    /** Each fragment's first byte to last byte, as kbit/s: the slowest tenth, and the middle. */
    kbpsP10: number | null;
    kbpsMedian: number | null;
    /**
     * Playing time spent with less than LOW_BUFFER_SECS of video ahead and no fragment being fetched: a player
     * idling while its buffer runs down, which no server log can tell from a slow link.
     */
    idleLowMs: number;
  };
  bandwidthEstimateKbps: number | null;
  droppedFrames: number | null;
  totalFrames: number | null;
  /** Every stall, of which the first MAX_STALLS are listed. */
  stallCount: number;
  stalledMs: number;
  stalls: Stall[];
  /** hls.js's error `details` and `MediaError <code>`, each once with how often it came. */
  errors: { details: string; fatal: boolean; count: number }[];
}

/** The `p`th percentile of `values` by nearest rank, rounded; null for none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return Math.round(sorted[rank - 1]!);
}

const tenth = (n: number) => Math.round(n * 10) / 10;

/** Seconds of `ranges` ahead of `time`: 0 where nothing is buffered there. */
export function aheadIn(ranges: TimeRanges, time: number): number {
  for (let i = 0; i < ranges.length; i++) {
    // A tenth of a second of slack: the play head sits on a range's start as often as inside it.
    if (ranges.start(i) <= time + 0.1 && time < ranges.end(i)) return tenth(ranges.end(i) - time);
  }
  return 0;
}

/** The counts behind a report, fed by `watchPlayback`. */
export class PlaybackRecorder {
  buffers: PlaybackStats['buffers'] = 'combined';
  private count = 0;
  private bytes = 0;
  private loadMs = 0;
  private slowestMs = 0;
  /** Each fragment's transfer rate, in kbit/s (bits per millisecond). */
  private rates: number[] = [];
  private stalls: Stall[] = [];
  private stallCount = 0;
  private stalledMs = 0;
  private open: { stall: Stall; since: number } | undefined;
  private errors: PlaybackStats['errors'] = [];
  private idleLowMs = 0;

  constructor(
    readonly engine: PlaybackStats['engine'],
    readonly browser: string,
  ) {}

  /** A fragment arrived: `bytes`, requested at `start`, first byte at `first`, last at `end` (ms). */
  fragment(bytes: number, { start, first, end }: { start: number; first: number; end: number }) {
    const took = end - start;
    if (!(bytes > 0) || !(took >= 0)) return;
    this.count += 1;
    this.bytes += bytes;
    this.loadMs += took;
    this.slowestMs = Math.max(this.slowestMs, took);
    if (end > first) this.rates.push((bytes * 8) / (end - first));
  }

  /** Playback stopped at `now`. False when it was already stopped: one stall, however many signals say so. */
  stalled(now: number, stall: Omit<Stall, 'ms'>): boolean {
    if (this.open) return false;
    this.stallCount += 1;
    const entry: Stall = { ...stall, ms: null };
    if (this.stalls.length < MAX_STALLS) this.stalls.push(entry);
    this.open = { stall: entry, since: now };
    return true;
  }

  /** The stall under way, if any. */
  get stalling(): Stall | undefined {
    return this.open?.stall;
  }

  /** Playing again at `now`. */
  resumed(now: number) {
    if (!this.open) return;
    const ms = Math.round(now - this.open.since);
    this.open.stall.ms = ms;
    this.stalledMs += ms;
    this.open = undefined;
  }

  /** `ms` of playing with little video ahead and nothing being fetched. */
  idleLow(ms: number) {
    if (ms > 0) this.idleLowMs += ms;
  }

  error(details: string, fatal: boolean) {
    const name = details.slice(0, 80);
    const seen = this.errors.find((e) => e.details === name && e.fatal === fatal);
    if (seen) seen.count += 1;
    else if (this.errors.length < MAX_ERRORS) this.errors.push({ details: name, fatal, count: 1 });
  }

  snapshot(
    event: ReportEvent,
    now: number,
    live: Pick<PlaybackStats, 'bandwidthEstimateKbps' | 'droppedFrames' | 'totalFrames'>,
  ): PlaybackStats {
    return {
      event,
      browser: this.browser,
      engine: this.engine,
      buffers: this.buffers,
      fragments: {
        count: this.count,
        bytes: this.bytes,
        loadMs: Math.round(this.loadMs),
        slowestMs: Math.round(this.slowestMs),
        kbpsP10: percentile(this.rates, 10),
        kbpsMedian: percentile(this.rates, 50),
        idleLowMs: Math.round(this.idleLowMs),
      },
      ...live,
      stallCount: this.stallCount,
      stalledMs: this.stalledMs + (this.open ? Math.round(now - this.open.since) : 0),
      stalls: this.stalls.map((s) => ({ ...s })),
      errors: this.errors.map((e) => ({ ...e })),
    };
  }
}

/**
 * The report's JSON: den-remux's `{code, message}`, with `stats` beside them. Held to `maxBytes` by dropping the
 * latest stalls and errors first — the first stall is the one that says most.
 */
export function reportBody(
  code: number,
  message: string,
  stats?: PlaybackStats,
  maxBytes = MAX_REPORT_BYTES,
): string {
  const body = { code, message: message.slice(0, 200), ...(stats ? { stats } : {}) };
  const size = (text: string) => new TextEncoder().encode(text).length;
  let text = JSON.stringify(body);
  while (stats && size(text) > maxBytes && (stats.stalls.length || stats.errors.length)) {
    if (stats.errors.length >= stats.stalls.length) stats.errors.pop();
    else stats.stalls.pop();
    text = JSON.stringify(body);
  }
  return text;
}

/**
 * When reports go, `max` at most, of which the last is kept for the end: at the first stall, again at least
 * `interval` later if stalls kept coming (a stall inside it waits for its end, and one report carries all of them),
 * when the page is hidden while one is left, and once at the end.
 */
export class ReportSchedule {
  private last: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sent = 0;
  private ended = false;

  constructor(
    private readonly send: (event: ReportEvent) => void,
    private readonly now: () => number = () => performance.now(),
    private readonly interval = REPORT_INTERVAL_MS,
    private readonly max = MAX_REPORTS,
  ) {}

  /** Whether a report other than the last may still go. */
  private get spare(): boolean {
    return !this.ended && this.sent < this.max - 1;
  }

  stall() {
    if (!this.spare || this.timer !== undefined) return;
    const wait = this.last === undefined ? 0 : this.last + this.interval - this.now();
    if (wait <= 0) this.fire('stall');
    else
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (this.spare) this.fire('stall');
      }, wait);
  }

  hidden() {
    if (this.spare) this.fire('hidden');
  }

  /** A report went to the same session from elsewhere (`reportFailure`), and counts against `max`. */
  spent() {
    this.sent += 1;
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    if (this.sent < this.max) this.fire('end');
  }

  private fire(event: ReportEvent) {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.last = this.now();
    this.sent += 1;
    this.send(event);
  }
}

interface UserAgentData {
  brands?: { brand: string; version: string }[];
  platform?: string;
}

/** Browser and major version, and OS — `Chrome 141 / Windows` — from the client hints where there are any. */
export function browserName(
  nav: { userAgent?: string; userAgentData?: UserAgentData } | undefined = globalThis.navigator,
): string {
  const ua = nav?.userAgent ?? '';
  const hints = nav?.userAgentData;
  const brands = (hints?.brands ?? []).filter((b) => !/not.?a.?brand/i.test(b.brand));
  const brand = brands.find((b) => b.brand !== 'Chromium') ?? brands[0];
  const os =
    hints?.platform ||
    (
      [
        [/Windows/, 'Windows'],
        [/iPhone|iPad|iPod/, 'iOS'],
        [/Mac OS X|Macintosh/, 'macOS'],
        [/Android/, 'Android'],
        [/CrOS/, 'ChromeOS'],
        [/Linux/, 'Linux'],
      ] as const
    ).find(([pattern]) => pattern.test(ua))?.[1] ||
    'unknown OS';
  let browser = brand ? `${brand.brand} ${brand.version}` : undefined;
  if (!browser) {
    const found = (
      [
        [/Edg(?:A|iOS)?\/(\d+)/, 'Edge'],
        [/OPR\/(\d+)/, 'Opera'],
        [/(?:Firefox|FxiOS)\/(\d+)/, 'Firefox'],
        [/(?:Chrome|CriOS)\/(\d+)/, 'Chrome'],
        [/Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari/, 'Safari'],
      ] as const
    )
      .map(([pattern, name]) => [pattern.exec(ua)?.[1], name] as const)
      .find(([version]) => version);
    browser = found ? `${found[1]} ${found[0]}` : 'unknown browser';
  }
  return `${browser} / ${os}`.slice(0, 80);
}

/** POST a report; not retried, since the next one carries everything this one did. Kept alive past the page's close. */
export function sendReport(url: string, body: string, fetchImpl: typeof fetch = fetch): void {
  void fetchImpl(url, { method: 'POST', body, keepalive: true })
    .then((res) => {
      if (!res.ok) console.warn(`playback report: den-remux answered ${res.status}`);
    })
    .catch((error: unknown) => console.warn('playback report not sent:', error));
}

/** A session's report URL, beside its playlist. */
export function reportUrlOf(playlist: string): string {
  return playlist.replace(/master\.m3u8$/, 'report');
}

export interface WatchOptions {
  video: HTMLVideoElement;
  /** hls.js playing into `video`, with its class for the event names; absent where the browser plays HLS itself. */
  hls?: { instance: Hls; Hls: typeof Hls };
  reportUrl: string;
  send?: (url: string, body: string) => void;
  now?: () => number;
}

export interface Watcher {
  /** Send the last report and stop; call it before hls.js is destroyed, while its estimate can still be read. */
  stop(): void;
  /** Count a report sent to this session from elsewhere, against den-remux's MAX_REPORTS. */
  spent(): void;
}

/** Record a session's playback into reports (`ReportSchedule`). Nothing here waits on or retries a send. */
export function watchPlayback(options: WatchOptions): Watcher {
  const { video, hls, reportUrl } = options;
  const now = options.now ?? (() => performance.now());
  const send = options.send ?? sendReport;
  const recorder = new PlaybackRecorder(hls ? 'hls.js' : 'native', browserName());
  const listening = new AbortController();
  let stopped = false;
  let started = false;
  let sources: { video?: SourceBuffer; audio?: SourceBuffer } = {};
  /**
   * The last time the decoded frame count moved: where the play head was, and what was buffered ahead of it then — a
   * frozen stall is placed there, so its buffer is read there too, not seconds later when it is noticed.
   */
  let frames: { count: number; at: number; buffered?: Pick<Stall, 'videoAhead' | 'audioAhead'> } = {
    count: -1,
    at: 0,
  };
  /** The fragment hls.js is fetching, by its sequence number, and when the last one arrived. */
  let fetching: number | 'initSegment' | undefined;
  let arrived: number | undefined;
  /** When the last `timeupdate` came, to count playing time between two of them. */
  let lastTick: number | undefined;
  const requests = (): Pick<Stall, 'loading' | 'idleMs'> =>
    !hls
      ? { loading: null, idleMs: null }
      : fetching !== undefined
        ? { loading: true, idleMs: null }
        : { loading: false, idleMs: arrived === undefined ? null : Math.round(now() - arrived) };

  const live = () => {
    const quality = video.getVideoPlaybackQuality?.();
    const bps = hls?.instance.bandwidthEstimate;
    return {
      bandwidthEstimateKbps: bps && Number.isFinite(bps) && bps > 0 ? Math.round(bps / 1000) : null,
      droppedFrames: quality?.droppedVideoFrames ?? null,
      totalFrames: quality?.totalVideoFrames ?? null,
    };
  };
  const schedule = new ReportSchedule(
    (event) =>
      send(
        reportUrl,
        reportBody(0, `playback stats (${event})`, recorder.snapshot(event, now(), live())),
      ),
    now,
  );

  const ahead = (time: number): Pick<Stall, 'videoAhead' | 'audioAhead'> => {
    if (sources.video && sources.audio) {
      try {
        return {
          videoAhead: aheadIn(sources.video.buffered, time),
          audioAhead: aheadIn(sources.audio.buffered, time),
        };
      } catch (error) {
        // A SourceBuffer hls.js has since removed throws on `buffered`: the element's own is still there.
        console.warn('playback report: reading a SourceBuffer failed, using the element’s:', error);
      }
    }
    const both = aheadIn(video.buffered, time);
    return { videoAhead: both, audioAhead: both };
  };

  const stall = (
    kind: Stall['kind'],
    at = video.currentTime,
    buffered = ahead(video.currentTime),
  ) => {
    if (stopped || !started || video.seeking) return;
    const stalled = { at: tenth(at), kind, ...buffered, ...requests() };
    if (recorder.stalled(now(), stalled)) schedule.stall();
  };

  const on = <K extends keyof HTMLMediaElementEventMap>(type: K, listener: () => void) =>
    video.addEventListener(type, listener, { signal: listening.signal });
  on('playing', () => {
    started = true;
    recorder.resumed(now());
  });
  on('waiting', () => stall('wait'));
  on('stalled', () => {
    if (!video.paused && video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) stall('wait');
  });
  on('seeked', () => {
    frames = {
      count: video.getVideoPlaybackQuality?.().totalVideoFrames ?? -1,
      at: video.currentTime,
      buffered: ahead(video.currentTime),
    };
  });
  on('timeupdate', () => {
    const time = video.currentTime;
    const tick = now();
    const since = lastTick === undefined ? 0 : tick - lastTick;
    lastTick = tick;
    // Playing on a low buffer with nothing asked for — not at the end of the film, where there is nothing left to ask.
    if (hls && started && !video.paused && fetching === undefined) {
      const { videoAhead } = ahead(time);
      const end = Number.isFinite(video.duration) ? video.duration : Infinity;
      if (videoAhead !== null && videoAhead < LOW_BUFFER_SECS && time + videoAhead < end - 0.5)
        recorder.idleLow(since);
    }
    const open = recorder.stalling;
    if (open?.kind === 'wait' && !video.paused && time > open.at + 0.2) recorder.resumed(now());
    const count = video.getVideoPlaybackQuality?.().totalVideoFrames;
    if (count === undefined) return;
    if (count !== frames.count) {
      frames = { count, at: time, buffered: ahead(time) };
      if (open?.kind === 'frozen') recorder.resumed(now());
      return;
    }
    // A hidden page decodes no video in some browsers, and that is not a frozen picture.
    if (!video.paused && document.visibilityState === 'visible' && time - frames.at >= FROZEN_SECS)
      stall('frozen', frames.at, frames.buffered);
  });
  on('error', () => {
    if (video.error) recorder.error(`MediaError ${video.error.code}`, true);
  });
  document.addEventListener(
    'visibilitychange',
    () => {
      if (!stopped && document.visibilityState === 'hidden') schedule.hidden();
    },
    { signal: listening.signal },
  );

  if (hls) {
    const { instance, Hls: HlsClass } = hls;
    instance.on(HlsClass.Events.FRAG_LOADING, (_event, data) => {
      if (data.frag.type !== 'subtitle') fetching = data.frag.sn;
    });
    instance.on(HlsClass.Events.FRAG_LOADED, (_event, data) => {
      if (stopped || data.frag.type === 'subtitle') return;
      if (data.frag.sn === fetching) fetching = undefined;
      arrived = now();
      const stats = (data.part ?? data.frag).stats;
      recorder.fragment(stats.loaded || stats.total, stats.loading);
    });
    instance.on(HlsClass.Events.BUFFER_CREATED, (_event, data) => {
      sources = { video: data.tracks.video?.buffer, audio: data.tracks.audio?.buffer };
      recorder.buffers = sources.video && sources.audio ? 'separate' : 'combined';
    });
    instance.on(HlsClass.Events.ERROR, (_event, data) => {
      if (stopped) return;
      // A failed fetch is no longer under way; a retry is another FRAG_LOADING.
      if (data.frag && data.frag.sn === fetching) fetching = undefined;
      recorder.error(data.details, data.fatal);
      if (STALL_DETAILS.has(data.details) && !video.paused) stall('wait');
    });
  }

  return {
    stop() {
      if (stopped) return;
      schedule.end();
      stopped = true;
      listening.abort();
    },
    spent: () => schedule.spent(),
  };
}
