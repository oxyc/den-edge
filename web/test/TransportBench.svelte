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
      // A height step nothing has asked for before, so reel has no index for it and has to build one. Every
      // other progressive row here answers `cache;desc=hit` once the page has been used at all, which makes
      // them warm numbers — useful, but not what a viewer opening a fresh title pays. Check the `reel` column
      // to confirm this one really did build: `index` with a duration, rather than `cache hit`.
      {
        name: 'progressive 480 audio (cold)',
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
    const done = new Promise<void>((resolve) => {
      const mark = (event: Event) => {
        const key = event.type as 'loadstart' | 'loadedmetadata' | 'canplay' | 'playing';
        result[key] ??= since();
        // `playing` is the last event worth waiting for where no frame callback exists.
        if (key === 'playing' && !video.requestVideoFrameCallback) resolve();
      };
      for (const event of ['loadstart', 'loadedmetadata', 'canplay', 'playing'])
        video.addEventListener(event, mark);
      video.addEventListener('error', () => {
        result.error ??= `media ${video.error?.code ?? 0}`;
        resolve();
      });
      video.requestVideoFrameCallback?.(() => {
        result.firstFrame = since();
        resolve();
      });
      setTimeout(() => {
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
    // Read the network's account of it before the element is reset and the entry is all there is.
    result.server = serverTiming(src);
    result.bytes = bytesOf(src);
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
      { ua: navigator.userAgent, nativeHls: PLAYS_HLS, at: new Date().toISOString(), runs },
      null,
      1,
    ),
  );
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
      Times are milliseconds from the moment <code>src</code> was set. Paste this into the ticket:
    </p>
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
