<!-- How long a trailer takes to put a picture on screen, per transport, in whichever browser is running this.
     Not an e2e test: it is a measuring instrument, run by hand, and its output is numbers to paste into a
     ticket.

     It exists because every trailer number we have argued over was typed into a console by hand, one sample,
     with a different clock per element — and one of those comparisons (a billboard measurement quoted at the
     detail hero) cost two releases. This runs every transport against the SAME video, back to back, on one
     clock, and repeats each one.

     Open it at http://127.0.0.1:5173/test/transport.html with `npm run dev`. The dev server proxies /reel
     straight to reel (vite.config.ts), so the URLs here are the real signed ones and the bytes are real.
     For Safari or an iPhone, open it in THAT browser — Playwright's WebKit has no AVFoundation and so cannot
     answer the question this page exists for. `npm run dev -- --host` and the tailnet name reach a phone. -->
<script lang="ts">
  import { nativeHls } from '../src/lib/reel';

  /** `requestVideoFrameCallback`: the only honest "a frame is on screen" signal. Safari 15.4+, Chrome 83+. */
  type FrameVideo = HTMLVideoElement & {
    requestVideoFrameCallback?: (callback: (now: number) => void) => number;
  };

  /** What one load produced. Every time is milliseconds from the moment `src` was set. */
  type Run = {
    variant: string;
    run: number;
    url: string;
    loadstart?: number;
    loadedmetadata?: number;
    canplay?: number;
    playing?: number;
    /** The first frame the compositor actually showed. */
    firstFrame?: number;
    /**
     * reel's own account of the request: `resolve;dur=…`, `index;dur=…`, `cache;desc=hit`.
     *
     * Strings, not numbers, because the useful half is sometimes a description rather than a duration —
     * `cache;desc=hit` is what says an index was reused. Rounding that to a 0 ms duration once had me
     * reading a perfectly good 32 MB response as a redirect.
     */
    server?: Record<string, string>;
    bytes?: number;
    /**
     * The browser answered this one from its own HTTP cache, so the numbers describe a cache read and
     * `server` belongs to an EARLIER run: a cached response replays the headers it was stored with.
     */
    cached?: boolean;
    error?: string;
  };

  const PLAYS_HLS = nativeHls();
  /** Long enough for a cold resolve (~2.4 s) plus an index build, short enough not to hang the sweep. */
  const TIMEOUT_MS = 20_000;

  let source = $state('');
  let repeats = $state(2);
  let running = $state(false);
  let progress = $state('');
  let runs = $state<Run[]>([]);
  let element = $state<HTMLVideoElement>();

  /**
   * Films to walk, for the one measurement this page cannot otherwise get: a cold index.
   *
   * Whether a film is still cold is a fact about REEL, not about this browser — an index lives on the box and
   * is warm for everyone the moment anyone sweeps it. So nothing here can detect coldness, and the page names
   * the film rather than claiming anything about it. Read the `reel` column: an `index` entry with a duration
   * is a real build, `cache hit` is not.
   */
  const FILMS = [
    'tt0111161',
    'tt0068646',
    'tt0071562',
    'tt0468569',
    'tt0050083',
    'tt0108052',
    'tt0167260',
    'tt0110912',
    'tt0060196',
    'tt0120737',
  ];

  let movie = $state('');

  /**
   * Reel's trailer link for a film.
   *
   * Kept relative: the dev server proxies /reel, so the relative form is same-origin, which is also what keeps
   * it off the mixed-content rocks when this page is served over HTTPS to a phone.
   */
  async function pickFilm(film: string) {
    try {
      const answer = await fetch(`/reel/meta/movie/${film}.json`);
      const link = (await answer.json())?.meta?.links?.[0]?.trailers;
      if (typeof link !== 'string') return;
      const url = new URL(link, location.href);
      source = `/reel${url.pathname}${url.search}`;
      movie = film;
      // The old film's rows would otherwise sit under the new one's name in the report.
      runs = [];
    } catch {
      // reel out of reach from here: paste one by hand, as before.
    }
  }

  function nextFilm() {
    void pickFilm(FILMS[(FILMS.indexOf(movie) + 1) % FILMS.length]);
  }

  /**
   * Something real to start from, so the page is usable without hunting a URL down on a phone.
   *
   * Asked of reel rather than written into this file: its links are signed, signatures rot, and a signed URL
   * committed here would be both a secret with a half-life and a 404 waiting to happen. `?url=` names a
   * trailer directly, `?movie=<imdb id>` names a film to look one up for.
   */
  $effect(() => {
    if (source) return;
    const asked = new URLSearchParams(location.search).get('url');
    if (asked) {
      source = asked;
      return;
    }
    const film = new URLSearchParams(location.search).get('movie');
    void pickFilm(film && /^tt\d+$/.test(film) ? film : FILMS[0]);
  });

  /**
   * The variants, derived from one pasted URL.
   *
   * reel signs over the video and the install rather than the path, so the signature on any one of its media
   * URLs is the signature every sibling wants — which is why a single paste is enough, and why nothing here
   * needs a config or a /meta round trip.
   */
  const parts = $derived.by(() => {
    const raw = source.trim();
    if (!raw) return null;
    try {
      const url = new URL(raw, location.href);
      const id = url.pathname.match(
        /\/(?:play|hls|direct|progressive)\/([A-Za-z0-9_-]{11})\./,
      )?.[1];
      if (!id) return null;
      // Everything before the route segment, so a relayed path and an absolute one both survive.
      const mount = url.pathname.replace(/\/(?:play|hls|direct|progressive)\/[^/]+$/, '');
      return {
        origin: url.origin === location.origin ? '' : url.origin,
        mount,
        id,
        query: url.search,
      };
    } catch {
      return null;
    }
  });

  function at(route: string, extension: string, extra = ''): string {
    if (!parts) return '';
    const { origin, mount, id, query } = parts;
    const sep = query ? '&' : '?';
    return `${origin}${mount}/${route}/${id}.${extension}${query}${extra ? sep + extra : ''}`;
  }

  /** Every transport this page knows how to time, in the order a sweep runs them. */
  const variants = $derived.by(() => {
    if (!parts) return [];
    return [
      { name: 'progressive', url: at('progressive', 'mp4'), kind: 'file' as const, on: true },
      {
        name: 'progressive 720',
        url: at('progressive', 'mp4', 'height=720'),
        kind: 'file' as const,
        on: true,
      },
      {
        name: 'progressive audio',
        url: at('progressive', 'mp4', 'audio=1'),
        kind: 'file' as const,
        on: true,
      },
      {
        name: 'progressive 720 audio',
        url: at('progressive', 'mp4', 'height=720&audio=1'),
        kind: 'file' as const,
        on: true,
      },
      // Every progressive row here answers `cache;desc=hit` once the page has been used at all, which makes
      // them warm numbers — useful, but not what a viewer opening a fresh title pays. Check the `reel` column
      // to confirm this one really did build: `index` with a duration, rather than `cache hit`.
      //
      // THE HEIGHT IS NOT WHAT MAKES THIS COLD, and a sweep that assumes otherwise measures nothing. reel's
      // `height_cap` rounds a request DOWN to a rung of its ladder — `[720, 480]` — and anything below the
      // lowest rung is raised to it, so 540, 480 and 360 are one and the same index (`vid@480`). There are
      // exactly three progressive indexes per trailer: the full ladder, @720 and @480. A number nobody has
      // typed before is still an index somebody has already built.
      //
      // So a genuinely cold measurement needs a TRAILER nobody has resolved at this rung, not a new number:
      // point `?url=` at one, and read the FIRST run. Every sweep after that, on that trailer, is warm and the
      // `reel` column will say so — an `index` entry with a duration is a real build, and its absence means
      // this row measured a cache. (`cache;desc=hit` beside it refers to the URL resolve, not the index.)
      {
        name: 'progressive 480 audio (cold on a fresh trailer)',
        url: at('progressive', 'mp4', 'height=480&audio=1'),
        kind: 'file' as const,
        on: true,
      },
      {
        name: 'hls native',
        url: at('hls', 'm3u8', 'native=1'),
        kind: 'native' as const,
        on: PLAYS_HLS,
      },
      { name: 'hls managed', url: at('hls', 'm3u8'), kind: 'managed' as const, on: !PLAYS_HLS },
      { name: 'google raw', url: at('direct', 'json'), kind: 'google' as const, on: true },
      // Cold, this downloads the video and re-muxes it: seconds to minutes. Off unless asked for.
      { name: 'play copy', url: at('play', 'mp4'), kind: 'file' as const, on: false },
    ];
  });

  let chosen = $state<Record<string, boolean>>({});
  const picked = $derived(variants.filter((v) => chosen[v.name] ?? v.on));

  /** reel's Server-Timing for a URL the browser has just fetched: a description where there is one, else ms. */
  function serverTiming(url: string): Record<string, string> | undefined {
    const entry = performance
      .getEntriesByType('resource')
      .filter((e): e is PerformanceResourceTiming => e.name === new URL(url, location.href).href)
      .at(-1);
    const timings = (
      entry as
        (PerformanceResourceTiming & { serverTiming?: PerformanceServerTiming[] }) | undefined
    )?.serverTiming;
    if (!timings?.length) return undefined;
    // The description first: `cache;desc=hit` carries no duration, and it is the one that says whether
    // this run measured a built index or a reused one — which decides what the number beside it means.
    return Object.fromEntries(
      timings.map((t) => [t.name, t.description || `${Math.round(t.duration)}ms`]),
    );
  }

  /**
   * Roughly what came down the wire, and only roughly.
   *
   * A media element fetches by range, and the entry for the URL then accounts for the headers rather than
   * the payload — Safari reported 302 bytes for a 32 MB file, which reads exactly like a redirect and is
   * not one. `encodedBodySize` is the less misleading of the two. Do not draw conclusions from this column
   * about whether bytes crossed the homelab; read the response with curl for that.
   */
  function bytesOf(url: string): number | undefined {
    const entry = performance
      .getEntriesByType('resource')
      .filter((e): e is PerformanceResourceTiming => e.name === new URL(url, location.href).href)
      .at(-1);
    return entry?.encodedBodySize || entry?.transferSize || undefined;
  }

  /**
   * Whether the browser answered this from its own HTTP cache instead of the network.
   *
   * Worth recording because a cached response replays the `Server-Timing` it was STORED with. Chrome's
   * second repeat reported `index;dur=2873` for a run that fetched nothing, which reads as the server
   * having built an index again — it had not, that was the FIRST run's build quoted back, and the numbers
   * beside it are a cache read. `transferSize` is 0 for a cache hit and non-zero for anything that crossed
   * the wire, a 304 included.
   */
  function fromCache(url: string): boolean {
    const entry = performance
      .getEntriesByType('resource')
      .filter((e): e is PerformanceResourceTiming => e.name === new URL(url, location.href).href)
      .at(-1);
    return !!entry && entry.transferSize === 0 && entry.decodedBodySize > 0;
  }

  /**
   * One load, timed.
   *
   * The element is reused rather than replaced: a fresh `<video>` per run measures element creation and
   * layout as well, and on WebKit an element that has never been in the document behaves differently again.
   * It is reset between runs instead.
   */
  async function time(variant: (typeof variants)[number], run: number): Promise<Run> {
    const video = element as FrameVideo | undefined;
    if (!video) return { variant: variant.name, run, url: variant.url, error: 'no element' };
    const result: Run = { variant: variant.name, run, url: variant.url };

    // `google raw` is a JSON lookup first: the point of it is playing Google's own URL, not reel's copy.
    let src = variant.url;
    if (variant.kind === 'google') {
      try {
        const answer = await fetch(variant.url);
        if (!answer.ok) return { ...result, error: `direct ${answer.status}` };
        const body = await answer.json();
        if (typeof body?.video !== 'string') return { ...result, error: 'no video URL' };
        src = body.video;
      } catch (error) {
        return { ...result, error: `direct ${String(error)}` };
      }
    }

    let engine: { destroy: () => void } | undefined;
    const started = performance.now();
    const since = () => Math.round(performance.now() - started);
    // Every listener and the deadline hang off this run, and are torn down with it below.
    //
    // They used to outlive it, on an element that is deliberately reused, and the damage was silent: a LATER
    // run's event would fill a field an EARLIER run never filled, timed from the EARLIER run's clock. That is
    // exactly the `firstFrame 166, playing 5107` on the 2026-09-16 iPhone sweep — the sweep advances at the
    // first frame, so `playing` was still empty when the next run fired one into it. `??=` cannot catch that,
    // because the field was genuinely empty. The stray deadline is the same shape: 20 s after a run that
    // finished in 90 ms, it would stamp `error: timeout` on a row that had already been reported good.
    const listeners = new AbortController();
    const { signal } = listeners;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const done = new Promise<void>((resolve) => {
      const mark = (event: Event) => {
        const key = event.type as 'loadstart' | 'loadedmetadata' | 'canplay' | 'playing';
        result[key] ??= since();
        // `playing` is the last event worth waiting for where no frame callback exists.
        if (key === 'playing' && !video.requestVideoFrameCallback) resolve();
      };
      for (const event of ['loadstart', 'loadedmetadata', 'canplay', 'playing'])
        video.addEventListener(event, mark, { signal });
      video.addEventListener(
        'error',
        () => {
          result.error ??= `media ${video.error?.code ?? 0}`;
          resolve();
        },
        { signal },
      );
      video.requestVideoFrameCallback?.(() => {
        result.firstFrame = since();
        resolve();
      });
      deadline = setTimeout(() => {
        result.error ??= 'timeout';
        resolve();
      }, TIMEOUT_MS);
    });

    if (variant.kind === 'managed') {
      const { default: Hls } = await import('hls.js');
      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: false });
        engine = hls;
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) result.error ??= `hls.js ${data.details}`;
        });
        hls.loadSource(src);
        hls.attachMedia(video);
      } else {
        result.error = 'no MSE';
      }
    } else {
      video.src = src;
    }
    void video.play().catch(() => {
      // A refused autoplay is not a transport fault; the events above still tell the story.
    });

    await done;
    clearTimeout(deadline);
    listeners.abort();
    // Read the network's account of it before the element is reset and the entry is all there is.
    result.server = serverTiming(src);
    result.bytes = bytesOf(src);
    if (fromCache(src)) result.cached = true;
    engine?.destroy();
    video.pause();
    video.removeAttribute('src');
    video.load();
    return result;
  }

  async function sweep() {
    if (!parts || running) return;
    running = true;
    runs = [];
    try {
      for (let run = 1; run <= repeats; run += 1)
        for (const variant of picked) {
          progress = `run ${run}/${repeats}: ${variant.name}`;
          runs = [...runs, await time(variant, run)];
        }
      progress = 'done';
    } finally {
      running = false;
    }
  }

  const report = $derived(
    JSON.stringify(
      {
        ua: navigator.userAgent,
        nativeHls: PLAYS_HLS,
        at: new Date().toISOString(),
        // Which trailer these numbers are about. Two reports are only comparable if they name the same one,
        // and a claim that a row was cold is only checkable against the film it was measured on.
        movie,
        video: parts?.id,
        runs,
      },
      null,
      1,
    ),
  );

  /** What the saved file is called, so a phone's report and a Mac's don't land on each other. */
  function reportName(): string {
    const ua = navigator.userAgent;
    const who = /iPhone|iPad/.test(ua)
      ? 'ios'
      : /Chrome/.test(ua)
        ? 'chrome'
        : /Safari/.test(ua)
          ? 'safari'
          : 'browser';
    return `transport-${who}-${new Date().toISOString().slice(0, 10)}.json`;
  }

  let saved = $state('');

  function download() {
    const href = URL.createObjectURL(new Blob([report], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = href;
    link.download = reportName();
    link.click();
    saved = `Saved as ${link.download}.`;
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  }

  /**
   * The share sheet, for a phone where a download is awkward to find again.
   *
   * Built and offered inside the click with nothing awaited first: iOS spends the transient activation on the
   * first await, and a share called after one is refused with no error worth showing.
   */
  function share() {
    const file = new File([report], reportName(), { type: 'application/json' });
    if (!navigator.canShare?.({ files: [file] })) {
      saved = 'This browser will not share a file — use Download.';
      return;
    }
    void navigator.share({ files: [file] }).catch(() => {
      // A dismissed sheet rejects, and that is a choice rather than a failure to report.
    });
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(report);
      saved = 'Copied.';
    } catch {
      saved = 'Copying was refused — use Download or Share.';
    }
  }
</script>

<main>
  <h1>Trailer transports</h1>
  <p>
    Paste any reel media URL for the trailer to measure — <code>/play</code>, <code>/hls</code>,
    <code>/direct</code> or <code>/progressive</code>. Every variant is derived from it, because
    reel signs over the video and the install rather than the path.
  </p>
  <p class="note">
    This browser: <b>{PLAYS_HLS ? 'plays HLS natively' : 'needs hls.js'}</b>. Real Safari and real
    iOS numbers only come from running this in those browsers — Playwright's WebKit has no
    AVFoundation.
  </p>

  <label class="row">
    <span>Reel URL</span>
    <input bind:value={source} placeholder="/reel/…/progressive/XXXXXXXXXXX.mp4?s=…&i=…&e=0" />
  </label>
  <label class="row">
    <span>Repeats</span>
    <input type="number" min="1" max="5" bind:value={repeats} />
  </label>
  <div class="row">
    <span>Film</span>
    <b>{movie || 'from the pasted URL'}</b>
    <button onclick={nextFilm} disabled={running}>Next trailer</button>
  </div>
  <p class="note">
    A cold index comes from a film nobody has swept yet — never from a height nobody has typed,
    since reel rounds every height onto one of two rungs. Sweeping a film warms it for every device,
    so the cold number is the <b>first</b> run on a film, once.
  </p>

  {#if parts}
    <fieldset>
      <legend>Variants</legend>
      {#each variants as variant (variant.name)}
        <label class="check">
          <input
            type="checkbox"
            checked={chosen[variant.name] ?? variant.on}
            onchange={(event) => (chosen[variant.name] = event.currentTarget.checked)}
          />
          {variant.name}
          {#if variant.name === 'play copy'}<em>— cold, this downloads and re-muxes: slow</em>{/if}
        </label>
      {/each}
    </fieldset>
    <button onclick={sweep} disabled={running}>{running ? progress : 'Measure'}</button>
  {:else if source.trim()}
    <p class="bad">That is not a reel media URL with an 11-character video id.</p>
  {/if}

  <!-- Muted and tiny, but in the document and visible: an offscreen or display:none video is exactly what
       WebKit declines to decode, which would measure the wrong thing. -->
  <video bind:this={element} muted playsinline preload="auto"></video>

  {#if runs.length}
    <table>
      <thead>
        <tr>
          <th>variant</th><th>run</th><th>meta</th><th>canplay</th><th>frame</th><th>reel</th>
          <th>bytes</th><th>error</th>
        </tr>
      </thead>
      <tbody>
        {#each runs as row (row.variant + row.run)}
          <tr class:bad={!!row.error}>
            <td>{row.variant}</td>
            <td>{row.run}</td>
            <td>{row.loadedmetadata ?? ''}</td>
            <td>{row.canplay ?? ''}</td>
            <td>{row.firstFrame ?? row.playing ?? ''}</td>
            <td
              >{row.server
                ? Object.entries(row.server)
                    .map(([k, v]) => `${k} ${v}`)
                    .join(', ')
                : ''}</td
            >
            <td>{row.bytes ? Math.round(row.bytes / 1024) + 'k' : ''}</td>
            <td>{row.error ?? ''}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p class="note">
      Times are milliseconds from the moment <code>src</code> was set. Take it away with one of these
      — selecting this much JSON by hand on a phone is its own small misery:
    </p>
    <!-- Off until the sweep ends. The table fills in as runs land, so these appear while it is still going —
         and a report taken then is missing rows without saying so, which reads as a browser that refused a
         transport rather than one that was never asked. Sharing mid-sweep also steals the tab, and a hidden
         tab stops drawing video: the act of saving would then break the run it was saving. -->
    <div class="save">
      <button onclick={download} disabled={running}>Download</button>
      <button onclick={share} disabled={running}>Share</button>
      <button onclick={copy} disabled={running}>Copy</button>
      {#if running}<span class="note"
          >Saving waits for the sweep — a half-swept report reads like a fault.</span
        >{:else if saved}<span class="note">{saved}</span>{/if}
    </div>
    <textarea readonly rows="8">{report}</textarea>
  {/if}
</main>

<style>
  main {
    max-width: 900px;
    margin: auto;
    padding: 24px 16px 64px;
    font:
      14px system-ui,
      sans-serif;
    line-height: 1.5;
  }

  .row {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 8px 0;
  }

  .row span {
    flex: 0 0 90px;
  }

  .row input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 6px 8px;
    font: inherit;
  }

  .check {
    display: block;
  }

  .note {
    color: #555;
  }

  .bad {
    color: #b00;
  }

  button {
    margin: 12px 0;
    padding: 8px 16px;
    font: inherit;
  }

  .save {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  video {
    display: block;
    width: 240px;
    height: 135px;
    margin: 12px 0;
    background: #000;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th,
  td {
    padding: 4px 6px;
    border-bottom: 1px solid #ddd;
    text-align: left;
    font-variant-numeric: tabular-nums;
  }

  textarea {
    width: 100%;
    font:
      12px ui-monospace,
      monospace;
  }
</style>
