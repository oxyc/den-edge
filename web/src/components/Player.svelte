<!-- Playback in this browser through den-remux: the title's release as HLS, played natively where the browser can
     (Safari, and so AirPlay) and through hls.js elsewhere. Starts where the library says, and reports where it got
     to every minute, on pause and on close. A browser den-remux doesn't know yet is asked for its key once. -->
<script lang="ts">
  import type Hls from 'hls.js';
  import { untrack } from 'svelte';
  import type { Title } from '../lib/library';
  import { endSession, login, startSession, type Failure, type Session } from '../lib/remux';
  import type { Scout } from '../lib/scout';
  import { fetchImdbId } from '../lib/tmdb';

  let {
    title,
    season,
    episode,
    tmdbKey,
    scout,
    subtitles,
    resume,
    onprogress,
    onclose,
  }: {
    title: Title;
    season?: number;
    episode?: number;
    tmdbKey: string;
    scout: Scout;
    /** The library's other LAN addons: den-subtitles is among them. */
    subtitles: string[];
    /** Where the library says this was left. */
    resume: { fraction: number; seconds?: number };
    onprogress: (fraction: number, seconds: number) => void;
    onclose: () => void;
  } = $props();

  const REPORT_MS = 60_000;
  const messages: Record<Exclude<Failure, 'login'> | 'imdb' | 'unsupported', string> = {
    none: 'No release of this that plays in a browser is ready right now. Try again later, or play it on your TV.',
    busy: 'Two things are already playing through Den. Stop one and try again.',
    transcode: 'This one needs converting for this browser, and the homelab is busy converting another. Try again in a few minutes.',
    unreachable: 'Couldn’t reach Den’s player. Check that this device is on your network.',
    imdb: 'TMDB has no IMDb id for this, which Den’s sources need.',
    unsupported: 'This browser can’t play video streams.',
  };

  let video = $state<HTMLVideoElement>();
  let session = $state<Session | null>(null);
  let failure = $state<Failure | 'imdb' | 'unsupported' | null>(null);
  let key = $state('');
  let badKey = $state(false);
  let hls: Hls | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reported = -1;
  let ended = false;

  const heading = $derived(season !== undefined ? `${title.title} · S${season} · E${episode}` : title.title);

  async function begin() {
    failure = null;
    const imdb = await fetchImdbId({ type: title.type, id: title.id }, tmdbKey);
    if (!imdb) {
      failure = imdb === null ? 'imdb' : 'unreachable';
      return;
    }
    const languages = [...new Set(navigator.languages.map((l) => l.split('-')[0]!.toLowerCase()))];
    const result = await startSession({
      imdb,
      season,
      episode,
      scout: scout.install,
      subtitles,
      subtitleLanguages: languages.slice(0, 2),
      audio: [...navigator.languages],
      videoCodecs: videoCodecs(),
    });
    if ('failure' in result) {
      failure = result.failure;
      return;
    }
    if (ended) return endSession(result);
    session = result;
  }

  async function letIn(event: SubmitEvent) {
    event.preventDefault();
    const ok = await login(key.trim());
    badKey = ok === false;
    if (ok === null) failure = 'unreachable';
    if (!ok) return;
    key = '';
    void begin();
  }

  /** HEVC where the browser decodes it; den-remux converts an HEVC-only release to H.264 for the rest. */
  function videoCodecs(): string[] {
    const hevc = 'video/mp4; codecs="hvc1.1.6.L93.B0"';
    const decodes = (globalThis.MediaSource?.isTypeSupported(hevc) ?? false) || document.createElement('video').canPlayType(hevc) !== '';
    return decodes ? ['h264', 'hevc'] : ['h264'];
  }

  $effect(() => {
    const [current, element] = [session, video];
    if (!current || !element) return;
    if (element.canPlayType('application/vnd.apple.mpegurl')) {
      element.src = current.playlist;
      return;
    }
    void import('hls.js').then(({ default: Hls }) => {
      if (ended) return;
      if (!Hls.isSupported()) {
        failure = 'unsupported';
        return;
      }
      hls = new Hls({ enableWorker: false });
      hls.loadSource(current.playlist);
      hls.attachMedia(element);
    });
  });

  function length(): number {
    if (video && Number.isFinite(video.duration) && video.duration > 0) return video.duration;
    return session?.duration ?? 0;
  }

  /** Pick up where it was left, unless that was the very start or the credits. */
  function seekToResume() {
    const total = length();
    if (!video || !total) return;
    const at = resume.seconds ?? resume.fraction * total;
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

  function finish() {
    if (ended) return;
    ended = true;
    clearInterval(timer);
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
    addEventListener('pagehide', finish);
    return () => {
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
          This browser isn’t let in to Den’s player yet. Enter a browser key from the homelab (<code
            >remux-browser-key.txt</code
          >) — once; the browser keeps it for a month.
        </p>
        <input type="password" bind:value={key} autocomplete="current-password" aria-label="Browser key" />
        <button class="primary" disabled={!key.trim()}>Let this browser in</button>
        {#if badKey}<p class="error" role="alert">That isn’t one of the homelab’s browser keys.</p>{/if}
      </form>
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
        onloadedmetadata={seekToResume}
        onplay={playing}
        onpause={paused}
        onended={report}
      ></video>
    {/if}
  </div>
  {#if session}
    <p class="release">
      {session.release.label}{session.video?.transcoded ? ' · converted to H.264 for this browser' : ''}
    </p>
  {/if}
</div>

<style>
  .player {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    grid-template-rows: auto 1fr auto;
    padding: max(12px, env(safe-area-inset-top)) var(--gutter) max(12px, env(safe-area-inset-bottom));
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

  header button,
  .primary {
    flex: 0 0 auto;
    padding: 8px 16px;
    border: 1px solid rgb(255 255 255 / 0.4);
    border-radius: 999px;
    background: none;
    color: #fff;
    cursor: pointer;
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
    display: grid;
    min-height: 0;
    place-items: center;
  }

  video {
    width: 100%;
    height: 100%;
    max-height: 100%;
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

  .note,
  .release {
    color: rgb(255 255 255 / 0.6);
  }

  .release {
    margin: 12px 0 0;
    font-size: 14px;
  }

  .error {
    max-width: 50ch;
    color: var(--danger);
    text-align: center;
  }
</style>
