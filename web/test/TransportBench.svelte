<!-- Manual Reel v2 timing instrument. Open /test/transport.html with `npm run dev`; the dev server
     proxies /reel to the real install. Reel owns logical-source order and Edge owns transport order.
     This page uses the product cursor and never derives sibling routes from an opaque capability. -->
<script lang="ts">
  import { nativeHls, PlaybackCursor, prepareTrailers, type PlaybackStep } from '../src/lib/reel';

  type FrameVideo = HTMLVideoElement & {
    requestVideoFrameCallback?: (callback: (now: number) => void) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
  };
  type Run = {
    run: number;
    candidate: number;
    source: number;
    attempt: number;
    transport: PlaybackStep['attemptType'];
    kind: PlaybackStep['kind'];
    size: string;
    loadedmetadata?: number;
    canplay?: number;
    playing?: number;
    firstFrame?: number;
    server?: Record<string, string>;
    bytes?: number;
    cached?: boolean;
    error?: string;
  };

  const PLAYS_HLS = nativeHls();
  const TIMEOUT_MS = 20_000;
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

  const asked = new URLSearchParams(location.search).get('movie');
  let movie = $state(asked && /^tt\d+$/.test(asked) ? asked : FILMS[0]);
  let repeats = $state(2);
  let running = $state(false);
  let progress = $state('');
  let failure = $state('');
  let runs = $state<Run[]>([]);
  let element = $state<HTMLVideoElement>();

  function nextFilm() {
    movie = FILMS[(FILMS.indexOf(movie) + 1) % FILMS.length];
    runs = [];
    failure = '';
  }

  function resource(url: string): PerformanceResourceTiming | undefined {
    const href = new URL(url, location.href).href;
    return performance
      .getEntriesByType('resource')
      .filter((entry): entry is PerformanceResourceTiming => entry.name === href)
      .at(-1);
  }

  function serverTiming(url: string): Record<string, string> | undefined {
    const timings = (
      resource(url) as
        (PerformanceResourceTiming & { serverTiming?: PerformanceServerTiming[] }) | undefined
    )?.serverTiming;
    if (!timings?.length) return undefined;
    return Object.fromEntries(
      timings.map((timing) => [
        timing.name,
        timing.description || `${Math.round(timing.duration)}ms`,
      ]),
    );
  }

  async function time(step: PlaybackStep, run: number): Promise<Run> {
    const video = element as FrameVideo | undefined;
    const result: Run = {
      run,
      candidate: step.candidate + 1,
      source: step.source + 1,
      attempt: step.attempt + 1,
      transport: step.attemptType,
      kind: step.kind,
      size: step.width && step.height ? `${step.width}×${step.height}` : '',
    };
    if (!video) return { ...result, error: 'no element' };

    let engine: { destroy: () => void } | undefined;
    const started = performance.now();
    const since = () => Math.round(performance.now() - started);
    const listeners = new AbortController();
    const { signal } = listeners;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let frameCallback: number | undefined;
    const done = new Promise<void>((resolve) => {
      const mark = (event: Event) => {
        const key = event.type as 'loadedmetadata' | 'canplay' | 'playing';
        result[key] ??= since();
        if (key === 'playing' && !video.requestVideoFrameCallback) resolve();
      };
      for (const event of ['loadedmetadata', 'canplay', 'playing'])
        video.addEventListener(event, mark, { signal });
      video.addEventListener(
        'error',
        () => {
          result.error ??= `media ${video.error?.code ?? 0}`;
          resolve();
        },
        { signal },
      );
      frameCallback = video.requestVideoFrameCallback?.(() => {
        result.firstFrame = since();
        resolve();
      });
      deadline = setTimeout(() => {
        result.error ??= 'timeout';
        resolve();
      }, TIMEOUT_MS);
    });

    if (step.kind === 'hls' && !PLAYS_HLS) {
      const { default: Hls } = await import('hls.js');
      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: false });
        engine = hls;
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) result.error ??= `hls.js ${data.details}`;
        });
        hls.loadSource(step.url);
        hls.attachMedia(video);
      } else {
        result.error = 'no MSE';
      }
    } else {
      video.src = step.url;
    }
    void video.play().catch(() => {
      // Autoplay refusal is not a transport fault; load and frame events still describe the attempt.
    });

    if (result.error !== 'no MSE') await done;
    clearTimeout(deadline);
    listeners.abort();
    if (frameCallback !== undefined) video.cancelVideoFrameCallback?.(frameCallback);
    const entry = resource(step.url);
    result.server = serverTiming(step.url);
    result.bytes = entry?.encodedBodySize || entry?.transferSize || undefined;
    if (entry && entry.transferSize === 0 && entry.decodedBodySize > 0) result.cached = true;
    engine?.destroy();
    video.pause();
    video.removeAttribute('src');
    video.load();
    return result;
  }

  async function sweep() {
    if (running || !/^tt\d+$/.test(movie)) return;
    running = true;
    runs = [];
    failure = '';
    try {
      const candidates = await prepareTrailers(
        '/reel',
        'movie',
        { imdb: movie },
        { reel: [{ url: location.origin }] },
        { surface: 'audible', player: PLAYS_HLS ? 'native' : 'hls.js' },
      );
      if (!candidates.length) {
        failure = 'Reel offered no trailer plan for this film.';
        return;
      }
      for (let run = 1; run <= repeats; run += 1) {
        const cursor = new PlaybackCursor(candidates);
        try {
          let step = await cursor.first();
          let number = 0;
          while (step) {
            number += 1;
            progress = `run ${run}/${repeats}: offered attempt ${number}`;
            runs = [...runs, await time(step, run)];
            step = await cursor.next();
          }
        } finally {
          cursor.close();
        }
      }
      if (!runs.length)
        failure = 'The offered plan contained no playable attempts for this browser.';
      progress = 'done';
    } catch (error) {
      failure = String(error);
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
        movie,
        runs,
      },
      null,
      1,
    ),
  );

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
  function share() {
    const file = new File([report], reportName(), { type: 'application/json' });
    if (!navigator.canShare?.({ files: [file] })) {
      saved = 'This browser will not share a file — use Download.';
      return;
    }
    void navigator.share({ files: [file] }).catch(() => {});
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
    Reel v2 offers logical sources; Edge chooses the ordered network attempts for this browser. This
    page times every offered attempt against the same film.
  </p>
  <p class="note">
    This browser: <b>{PLAYS_HLS ? 'plays HLS natively' : 'uses hls.js'}</b>. Real Safari and iOS
    numbers require those browsers; Playwright's WebKit does not use AVFoundation.
  </p>
  <label class="row">
    <span>IMDb film</span>
    <input bind:value={movie} disabled={running} placeholder="tt0111161" />
    <button onclick={nextFilm} disabled={running}>Next unswept film</button>
  </label>
  <label class="row short">
    <span>Repeats</span>
    <input type="number" min="1" max="5" bind:value={repeats} disabled={running} />
  </label>
  {#if movie && !/^tt\d+$/.test(movie)}
    <p class="bad">Enter an IMDb id such as <code>tt0111161</code>.</p>
  {/if}
  <button onclick={sweep} disabled={running || !/^tt\d+$/.test(movie)}>
    {running ? progress : 'Measure offered attempts'}
  </button>
  {#if failure}<p class="bad">{failure}</p>{/if}

  <!-- WebKit may decline to decode a display:none or offscreen video. -->
  <video bind:this={element} muted playsinline preload="auto"></video>

  {#if runs.length}
    <table>
      <thead>
        <tr>
          <th>run</th><th>plan step</th><th>kind</th><th>transport</th><th>size</th><th>meta</th><th
            >canplay</th
          ><th>frame</th><th>Reel timing</th><th>bytes</th><th>error</th>
        </tr>
      </thead>
      <tbody>
        {#each runs as row, index (`${row.run}:${row.candidate}:${row.source}:${row.attempt}:${index}`)}
          <tr class:bad={!!row.error}>
            <td>{row.run}</td>
            <td>{row.candidate}.{row.source}.{row.attempt}</td>
            <td>{row.kind}</td>
            <td>{row.transport}</td>
            <td>{row.size}</td>
            <td>{row.loadedmetadata ?? ''}</td>
            <td>{row.canplay ?? ''}</td>
            <td>{row.firstFrame ?? row.playing ?? ''}</td>
            <td
              >{row.server
                ? Object.entries(row.server)
                    .map(([key, value]) => `${key} ${value}`)
                    .join(', ')
                : ''}{row.cached ? ' (browser cache)' : ''}</td
            >
            <td>{row.bytes ? Math.round(row.bytes / 1024) + 'k' : ''}</td>
            <td>{row.error ?? ''}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p class="note">All event times are milliseconds from the moment the attempt was mounted.</p>
    <div class="save">
      <button onclick={download} disabled={running}>Download</button>
      <button onclick={share} disabled={running}>Share</button>
      <button onclick={copy} disabled={running}>Copy</button>
      {#if saved}<span class="note">{saved}</span>{/if}
    </div>
    <textarea readonly rows="8">{report}</textarea>
  {/if}
</main>

<style>
  main {
    max-width: 1100px;
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

  .row.short input {
    flex: 0 0 80px;
  }

  .note {
    color: #555;
  }

  .bad {
    color: #b00;
  }

  button {
    margin: 8px 0;
    padding: 8px 16px;
    font: inherit;
  }

  video {
    display: block;
    width: 240px;
    min-height: 135px;
    margin: 16px 0;
    background: #111;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }

  th,
  td {
    padding: 5px 7px;
    border-bottom: 1px solid #ddd;
    text-align: left;
    vertical-align: top;
  }

  .save {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  textarea {
    width: 100%;
    box-sizing: border-box;
    font:
      12px ui-monospace,
      monospace;
  }
</style>
