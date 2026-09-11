<!-- Playback in this browser through den-remux: the title's release as HLS, played natively where the browser can
     (Safari, and so AirPlay) and through hls.js elsewhere. The browser's own controls do the transport; the bars
     around the video carry what Den adds — the audio language, the next episode, and waiting for a free slot. Starts
     where the library says, and reports where it got to every minute, on pause and on close. -->
<script lang="ts">
  import type Hls from 'hls.js';
  import { untrack } from 'svelte';
  import type { Title } from '../lib/library';
  import { playable, type Playable } from '../lib/playable';
  import {
    endSession,
    login,
    reportFailure,
    startSession,
    type AudioTrack,
    type Failure,
    type Session,
  } from '../lib/remux';
  import type { Addon } from '../lib/scout';
  import { fetchImdbId } from '../lib/tmdb';

  let {
    title,
    season,
    episode,
    tmdbKey,
    scout,
    remux,
    subtitles,
    resume,
    next,
    onprogress,
    onnext,
    onclose,
  }: {
    title: Title;
    season?: number;
    episode?: number;
    tmdbKey: string;
    scout: Addon;
    /** Where den-remux answers (`findRemux`): '' for this origin, else the tailnet's address. */
    remux: string;
    /** The library's other LAN addons: den-subtitles is among them. */
    subtitles: string[];
    /** Where the library says this was left. */
    resume: { fraction: number; seconds?: number };
    /** The episode after this one, as `S2 · E4`, when there is one. */
    next?: string;
    onprogress: (fraction: number, seconds: number) => void;
    onnext?: () => void;
    onclose: () => void;
  } = $props();

  const REPORT_MS = 60_000;
  /** How long a video may go without a picture before it counts as one the browser can't play. */
  const STUCK_MS = 30_000;
  /** How long before asking again while every slot, or the GPU, is taken. */
  const RETRY_MS = 20_000;
  /** Seconds the next episode waits once this one has ended. */
  const UP_NEXT_SECS = 10;
  const messages: Record<'none' | 'unreachable' | 'imdb' | 'unsupported' | 'playback', string> = {
    none: 'No release of this that plays in a browser is ready right now. Try again later, or play it on your TV.',
    unreachable: 'Couldn’t reach Den’s player. Check that this device is on your network.',
    imdb: 'TMDB has no IMDb id for this, which Den’s sources need.',
    unsupported: 'This browser can’t play video streams.',
    playback: 'This browser couldn’t play this release. Try it on your TV.',
  };
  /** Waiting on den-remux, which is asked again every RETRY_MS. */
  const waits: Record<'busy' | 'transcode', string> = {
    busy: 'Den is already playing two things. Waiting for one to stop…',
    transcode: 'This needs converting for this browser, and the homelab is converting another. Waiting for it to finish…',
  };

  let video = $state<HTMLVideoElement>();
  let session = $state<Session | null>(null);
  let failure = $state<Failure | 'imdb' | 'unsupported' | 'playback' | null>(null);
  let key = $state('');
  let badKey = $state(false);
  /** Seconds until the next episode starts, once this one has ended. */
  let upNext = $state<number | null>(null);
  let imdb: string | undefined;
  let hls: Hls | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let countdown: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let reported = -1;
  let ended = false;
  /** Where the next session starts: a language switch picks up where the last one was. */
  let startAt: number | null = null;
  /** What this browser decodes, found once: den-remux converts only what won't play here. */
  let decodes: Playable | undefined;

  const heading = $derived(season !== undefined ? `${title.title} · S${season} · E${episode}` : title.title);
  const names = (() => {
    try {
      return new Intl.DisplayNames([navigator.language], { type: 'language' });
    } catch {
      return null;
    }
  })();

  /** Start a session: the release den-remux picks, or — with `pick` — the same release in another audio track. */
  async function begin(pick?: { audioTrack: number; filename: string }) {
    clearTimeout(retry);
    failure = null;
    if (!imdb) {
      const found = await fetchImdbId({ type: title.type, id: title.id }, tmdbKey);
      if (!found) {
        failure = found === null ? 'imdb' : 'unreachable';
        return;
      }
      imdb = found;
    }
    const languages = [...new Set(navigator.languages.map((l) => l.split('-')[0]!.toLowerCase()))];
    const can = (decodes ??= await playable());
    const result = await startSession({
      imdb,
      season,
      episode,
      scout: scout.install,
      subtitles,
      subtitleLanguages: languages.slice(0, 2),
      audio: [...navigator.languages],
      videoCodecs: can.hevcMain || can.hevcMain10 ? ['h264', 'hevc'] : ['h264'],
      playable: can,
      ...pick,
    }, undefined, remux);
    if (ended) {
      if (!('failure' in result)) endSession(result);
      return;
    }
    if ('failure' in result) {
      failure = result.failure;
      if (result.failure === 'busy' || result.failure === 'transcode') retry = setTimeout(() => void begin(pick), RETRY_MS);
      return;
    }
    session = result;
  }

  async function letIn(event: SubmitEvent) {
    event.preventDefault();
    const ok = await login(key.trim(), undefined, remux);
    badKey = ok === false;
    if (ok === null) failure = 'unreachable';
    if (!ok) return;
    key = '';
    void begin();
  }

  $effect(() => {
    const [current, element] = [session, video];
    if (!current || !element) return;
    // A browser that can't decode what it was sent doesn't always say so: Safari strikes out its play button and
    // fires nothing. Given no source it can use, or trying to play with no picture yet, after a while is that.
    const stuck = setTimeout(() => {
      const noSource = element.networkState === HTMLMediaElement.NETWORK_NO_SOURCE;
      if (noSource || (!element.paused && element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA)) {
        broke(element.error?.code ?? 0, `no picture after ${STUCK_MS / 1000} s (readyState ${element.readyState}, networkState ${element.networkState})`);
      }
    }, STUCK_MS);
    const cleanup = () => clearTimeout(stuck);
    element.addEventListener('loadeddata', cleanup, { once: true });
    if (element.canPlayType('application/vnd.apple.mpegurl')) {
      element.src = current.playlist;
      return cleanup;
    }
    void import('hls.js').then(({ default: Hls }) => {
      if (ended || session !== current) return;
      if (!Hls.isSupported()) {
        failure = 'unsupported';
        return;
      }
      hls = new Hls({ enableWorker: false });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) broke(0, `hls.js ${data.type} ${data.details}`);
      });
      hls.loadSource(current.playlist);
      hls.attachMedia(element);
    });
    return cleanup;
  });

  /** The browser gave up on the video: say so here, and tell den-remux why — no server log sees it otherwise. */
  function broke(code = video?.error?.code ?? 0, message = video?.error?.message ?? '') {
    if (!session || failure) return;
    reportFailure(session, code, message);
    failure = 'playback';
  }

  function length(): number {
    if (video && Number.isFinite(video.duration) && video.duration > 0) return video.duration;
    return session?.duration ?? 0;
  }

  /** Pick up where it was left — or where the last session was — unless that was the very start or the credits. */
  function seekToStart() {
    const total = length();
    if (!video || !total) return;
    const at = startAt ?? resume.seconds ?? resume.fraction * total;
    startAt = null;
    if (at > 5 && at / total < 0.95) video.currentTime = at;
  }

  function report() {
    const total = length();
    if (!video || !total || video.currentTime < 1) return;
    const second = Math.floor(video.currentTime);
    if (second === reported) return;
    reported = second;
    onprogress(video.currentTime / total, second);
  }

  function playing() {
    clearInterval(timer);
    timer = setInterval(report, REPORT_MS);
  }

  function paused() {
    clearInterval(timer);
    report();
  }

  /** The end: count down to the next episode, when there is one. */
  function finished() {
    report();
    if (!onnext) return;
    upNext = UP_NEXT_SECS;
    countdown = setInterval(() => {
      upNext = (upNext ?? 1) - 1;
      if (upNext > 0) return;
      stay();
      onnext?.();
    }, 1000);
  }

  function stay() {
    clearInterval(countdown);
    upNext = null;
  }

  /** Another audio track is another session of the same release (den-remux encodes one), from the same second. */
  function switchAudio(event: Event) {
    const n = Number((event.currentTarget as HTMLSelectElement).value);
    if (!session || !video || n === session.audioTrack) return;
    report();
    startAt = video.currentTime;
    const pick = { audioTrack: n, filename: session.release.filename };
    hls?.destroy();
    hls = undefined;
    endSession(session);
    session = null;
    void begin(pick);
  }

  function trackLabel(track: AudioTrack, n: number): string {
    let language: string | undefined;
    try {
      language = track.language ? (names?.of(track.language) ?? track.language) : undefined;
    } catch {
      language = track.language ?? undefined;
    }
    const channels = track.channels === 6 ? ' 5.1' : track.channels === 8 ? ' 7.1' : '';
    return `${language ?? track.name ?? `Track ${n + 1}`}${channels}${track.commentary ? ' · commentary' : ''}`;
  }

  function finish() {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    clearInterval(countdown);
    clearTimeout(retry);
    report();
    hls?.destroy();
    if (session) endSession(session);
  }

  function close() {
    finish();
    onclose();
  }

  $effect(() => {
    untrack(() => void begin());
    // The page behind stays put: it would otherwise scroll under a player that covers it.
    const scrolls = [document.documentElement, document.body].map((el) => [el, el.style.overflow] as const);
    for (const [el] of scrolls) el.style.overflow = 'hidden';
    addEventListener('pagehide', finish);
    return () => {
      for (const [el, overflow] of scrolls) el.style.overflow = overflow;
      removeEventListener('pagehide', finish);
      finish();
    };
  });
</script>

<svelte:window onkeydown={(event) => event.key === 'Escape' && !document.fullscreenElement && close()} />

<div class="player" role="dialog" aria-modal="true" aria-label={heading}>
  <header>
    <b>{heading}</b>
    <button onclick={close}>Close</button>
  </header>
  <div class="stage">
    {#if failure === 'login'}
      <form onsubmit={letIn}>
        <p>
          Your library’s scout install can only check what’s available, so playing it here needs a browser key from
          the homelab (<code>remux-browser-key.txt</code>) — once; the browser keeps it for a month.
        </p>
        <input type="password" bind:value={key} autocomplete="current-password" aria-label="Browser key" />
        <button class="primary" disabled={!key.trim()}>Let this browser in</button>
        {#if badKey}<p class="error" role="alert">That isn’t one of the homelab’s browser keys.</p>{/if}
      </form>
    {:else if failure === 'busy' || failure === 'transcode'}
      <p class="note" role="status">{waits[failure]}</p>
    {:else if failure}
      <p class="error" role="alert">{messages[failure]}</p>
    {:else if !session}
      <p class="note">Finding a release this browser can play…</p>
    {:else}
      <!-- svelte-ignore a11y_media_has_caption: den-remux's subtitles are renditions in the playlist, not <track>s -->
      <video
        bind:this={video}
        controls
        autoplay
        playsinline
        onloadedmetadata={seekToStart}
        onplay={playing}
        onpause={paused}
        onended={finished}
        onerror={() => broke()}
      ></video>
    {/if}
  </div>
  {#if session}
    <footer>
      <p class="release">
        {session.release.label}{session.video?.transcoded ? ' · converted to H.264 for this browser' : ''}
      </p>
      <div class="controls">
        {#if session.audioTracks.length > 1}
          <label>
            Audio
            <select value={session.audioTrack} onchange={switchAudio}>
              {#each session.audioTracks as track, n (n)}
                <option value={n}>{trackLabel(track, n)}</option>
              {/each}
            </select>
          </label>
        {/if}
        {#if onnext && next}
          {#if upNext !== null}
            <button
              class="primary"
              onclick={() => {
                stay();
                onnext();
              }}>Next: {next} ({upNext})</button
            >
            <button onclick={stay}>Stay</button>
          {:else}
            <button onclick={onnext}>Next: {next}</button>
          {/if}
        {/if}
      </div>
    </footer>
  {/if}
</div>

<style>
  /* The visible viewport (dvh: a phone's toolbars excluded), and a middle row that may shrink below the video's own
     height — so the video fits and its controls stay on screen. Every side keeps clear of a phone's camera cutout,
     which sits on the left or right edge in landscape. */
  .player {
    position: fixed;
    inset: 0 0 auto;
    z-index: 50;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    height: 100vh;
    height: 100dvh;
    padding: max(12px, env(safe-area-inset-top)) max(var(--gutter), env(safe-area-inset-right))
      max(12px, env(safe-area-inset-bottom)) max(var(--gutter), env(safe-area-inset-left));
    background: #000;
    color: #fff;
  }

  header {
    display: flex;
    gap: 16px;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 12px;
  }

  header b {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  button,
  select {
    flex: 0 0 auto;
    padding: 8px 16px;
    border: 1px solid rgb(255 255 255 / 0.4);
    border-radius: 999px;
    background: none;
    color: #fff;
    font: inherit;
    cursor: pointer;
  }

  select option {
    color: initial;
  }

  .primary {
    border-color: var(--accent);
    background: var(--accent);
    font-weight: 600;
  }

  .primary:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .stage {
    position: relative;
    display: grid;
    min-height: 0;
    place-items: center;
  }

  video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  form {
    display: grid;
    gap: 12px;
    width: min(420px, 100%);
  }

  input {
    padding: 12px 16px;
    border: 1px solid rgb(255 255 255 / 0.3);
    border-radius: 12px;
    background: rgb(255 255 255 / 0.08);
    color: #fff;
  }

  footer {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    align-items: center;
    justify-content: space-between;
    padding-top: 12px;
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  label {
    display: flex;
    gap: 8px;
    align-items: center;
    color: rgb(255 255 255 / 0.6);
    font-size: 14px;
  }

  .note,
  .release {
    max-width: 50ch;
    color: rgb(255 255 255 / 0.6);
    text-align: center;
  }

  .release {
    margin: 0;
    font-size: 14px;
    text-align: left;
  }

  .error {
    max-width: 50ch;
    color: var(--danger);
    text-align: center;
  }
</style>
