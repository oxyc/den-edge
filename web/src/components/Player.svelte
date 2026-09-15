<!-- Playback in this browser through den-remux: the title's release as HLS, played natively where the browser can
     (Safari, and so AirPlay) and through hls.js elsewhere. The browser's own controls do the transport; the bars
     around the video carry what Den adds — the audio language, the next episode, and waiting for a free slot. Starts
     where the library says, and reports where it got to every minute, on pause, when the page is hidden and on close.
     The lock screen and the system's media controls name the title and move it too. -->
<script lang="ts">
  import type Hls from 'hls.js';
  import { untrack } from 'svelte';
  import type { Title } from '../lib/library';
  import { playable, withoutRefused, type Playable } from '../lib/playable';
  import {
    downmixLabel,
    nativeHls,
    endSession,
    linkLimit,
    listReleases,
    login,
    releaseParts,
    reportFailure,
    startSession,
    wantedLanguages,
    type AudioTrack,
    type Failure,
    type Release,
    type Session,
  } from '../lib/remux';
  import type { Addon } from '../lib/scout';
  import { fetchImdbId } from '../lib/tmdb';

  let {
    title,
    season,
    episode,
    filename,
    tmdbKey,
    scout,
    remux,
    subtitles,
    audioLanguage,
    subtitleLanguage,
    resume,
    next,
    onprogress,
    onnext,
    onclose,
  }: {
    title: Title;
    season?: number;
    episode?: number;
    filename?: string;
    tmdbKey: string;
    scout: Addon;
    /** Where den-remux answers (`findRemux`): '' for this origin, else the tailnet's address. */
    remux: string;
    /** The library's other LAN addons: den-subtitles is among them. */
    subtitles: string[];
    /** Settings › Playback's audio language (ISO 639-1); undefined is each title's original language. */
    audioLanguage?: string;
    /** Its subtitle language; undefined is off. */
    subtitleLanguage?: string;
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
  /** How far from the asked-for second a native player may start and still count as there: it starts on a segment. */
  const START_SLACK_SECS = 10;
  /** How long before asking again while every slot, or the GPU, is taken — unless den-remux names its own. */
  const RETRY_MS = 20_000;
  /** Seconds the next episode waits once this one has ended. */
  const UP_NEXT_SECS = 10;
  /**
   * How close to the last report a hidden page's close may be and write nothing: hiding the page already wrote it, and
   * closing a tab hides it just before `pagehide`.
   */
  const HIDDEN_SLACK_SECS = 5;
  /** The step of the lock screen's and a headset's skip buttons, where they don't name one. */
  const SKIP_SECS = 10;
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
    transcode:
      'This needs converting for this browser, and the homelab is converting another. Waiting for it to finish…',
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
  let startAt: { fraction: number; seconds?: number } | null = null;
  /** The second den-remux was asked to start the playing session at; undefined when it was asked for none. */
  let started: number | undefined;
  /** What this browser decodes, found once: den-remux converts only what won't play here. */
  let decodes: Playable | undefined;
  /** The title's releases den-remux could play, to pick another from. */
  let releases = $state<Release[]>([]);
  /**
   * Whether this release has already been asked for again with the browser's claims cut back.
   *
   * A browser can claim a codec, take the playlist, and then refuse the very first segment — an iPhone
   * does exactly that with a 4K HDR Main-tier HEVC remux it says it decodes, and did it again with the
   * 1080p H.264 conversion of that same file while its E-AC-3 track was still being copied through. So a
   * refusal is taken to disprove the whole session, sound and picture: den-remux keeps a release the
   * player can't take as the fallback it converts on the GPU, and asking again as a player that takes
   * none of it is what gets that conversion. Once only: what is left is H.264 with AAC, and nothing here
   * makes that smaller.
   */
  let degraded = false;

  const heading = $derived(
    season !== undefined ? `${title.title} · S${season} · E${episode}` : title.title,
  );
  const names = (() => {
    try {
      return new Intl.DisplayNames([navigator.language], { type: 'language' });
    } catch {
      return null;
    }
  })();

  /** Start a session: the release den-remux picks, or the one `pick` names — in another audio track, perhaps. */
  async function begin(
    pick: { audioTrack?: number; filename: string } | undefined = filename
      ? { filename }
      : undefined,
  ) {
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
    const { audio, subtitleLanguages } = wantedLanguages(
      { audio: audioLanguage, subtitle: subtitleLanguage },
      title.originalLanguage,
      navigator.languages,
    );
    const claimed = (decodes ??= await playable());
    // What this browser hasn't disproved. After a refusal it asks as something that takes no HEVC, no HDR
    // and no E-AC-3, which is what makes den-remux convert the release — sound included — rather than copy
    // any part of it again.
    const can = degraded ? withoutRefused(claimed) : claimed;
    // Away from home every byte crosses the home upload: den-remux is told what the link carries, measured once.
    const maxBitrate = await linkLimit(remux);
    // Not the very start, nor the credits. A resume the library holds as a fraction alone can't be named before the
    // video's length is known: it is sought to once the video has loaded, as before.
    const from = startAt ?? resume;
    const at =
      from.seconds !== undefined && from.seconds > 5 && from.fraction < 0.95
        ? from.seconds
        : undefined;
    const result = await startSession(
      {
        imdb,
        season,
        episode,
        scout: scout.install,
        subtitles,
        subtitleLanguages,
        audio,
        videoCodecs: can.hevcMain || can.hevcMain10 ? ['h264', 'hevc'] : ['h264'],
        playable: can,
        startAt: at,
        maxBitrate,
        // For den-remux's log only, so a session can be told apart by the player that played it.
        player: nativeHls(document.createElement('video')) ? 'native' : 'hls.js',
        ...pick,
      },
      undefined,
      remux,
    );
    if (ended) {
      if (!('failure' in result)) endSession(result);
      return;
    }
    if ('failure' in result) {
      failure = result.failure;
      if (result.failure === 'busy' || result.failure === 'transcode')
        // What it asked for, where it said: a converting GPU can mean minutes, and knocking every
        // twenty seconds until then is work for a box that is already the reason we are waiting.
        retry = setTimeout(() => void begin(pick), result.retryMs ?? RETRY_MS);
      return;
    }
    started = at;
    session = result;
    if (!releases.length) {
      void listReleases({ imdb, season, episode, scout: scout.install }, undefined, remux).then(
        (list) => {
          releases = list ?? [];
        },
      );
    }
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
      if (
        noSource ||
        (!element.paused && element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA)
      ) {
        broke(
          element.error?.code ?? 0,
          `no picture after ${STUCK_MS / 1000} s (readyState ${element.readyState}, networkState ${element.networkState})`,
        );
      }
    }, STUCK_MS);
    const cleanup = () => clearTimeout(stuck);
    element.addEventListener('loadeddata', cleanup, { once: true });
    if (nativeHls(element)) {
      element.src = current.playlist;
      return cleanup;
    }
    void import('hls.js').then(({ default: Hls }) => {
      if (ended || session !== current) return;
      if (!Hls.isSupported()) {
        failure = 'unsupported';
        return;
      }
      // -1 is hls.js's own default: the playlist's start, or the beginning.
      hls = new Hls({
        enableWorker: false,
        startPosition: started ?? -1,
        // den-remux converts on the GPU as the player asks for segments, so the first one of a transcoded release
        // can take far longer to answer than a copied one. hls.js gives up on a segment about ten seconds late and
        // by default doesn't retry a timeout at all, which turns a slow conversion into a dead session. Wait
        // through it instead, and retry twice before calling it broken.
        fragLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 30_000,
            maxLoadTimeMs: 120_000,
            timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
            errorRetry: { maxNumRetry: 2, retryDelayMs: 1_000, maxRetryDelayMs: 8_000 },
          },
        },
      });
      // A fatal media error is sometimes just a decoder that lost its place, which hls.js can reset the buffer and
      // carry on from. Try that once per session; a second one is a real refusal and goes to broke() as before, so
      // the release is still asked for again as a player that takes none of what it just refused.
      let recovered = false;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
          recovered = true;
          hls?.recoverMediaError();
          return;
        }
        broke(0, `hls.js ${data.type} ${data.details}`);
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
    // It was copied because this browser said it could take it, and it couldn't. Ask for the same release
    // again as a player that takes none of what it just refused: den-remux had that file queued as the
    // fallback it converts, so this is the ask it was waiting for. A conversion that won't decode is not
    // helped by converting it again, so this happens once.
    if (!degraded && !session.video?.transcoded) {
      degraded = true;
      restart({ filename: session.release.filename });
      return;
    }
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
    const from = startAt ?? resume;
    startAt = null;
    if (started !== undefined) {
      // den-remux was asked to start there: hls.js was given it as its start position, and Safari's own player reads
      // the playlist's EXT-X-START. A seek is only for a native player that didn't start near it — a den-remux that
      // names no start — so the picture never jumps twice.
      if (!hls && Math.abs(video.currentTime - started) > START_SLACK_SECS)
        video.currentTime = started;
      return;
    }
    const at = from.seconds ?? from.fraction * total;
    if (at > 5 && at / total < 0.95) video.currentTime = at;
  }

  /** Write where playback got to, unless it is within `slack` seconds of what was last written. */
  function report(slack = 0) {
    const total = length();
    if (!video || !total || video.currentTime < 1) return;
    const second = Math.floor(video.currentTime);
    if (reported >= 0 && Math.abs(second - reported) <= slack) return;
    reported = second;
    onprogress(video.currentTime / total, second);
  }

  function playing() {
    clearInterval(timer);
    timer = setInterval(() => report(), REPORT_MS);
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
    if (!session || n === session.audioTrack) return;
    restart({ audioTrack: n, filename: session.release.filename });
  }

  /** Another release of the title, from the same second — also after this one wouldn't play. */
  function switchRelease(event: Event) {
    const filename = (event.currentTarget as HTMLSelectElement).value;
    if (!session || filename === session.release.filename) return;
    // Another file gets this browser's full claims: what one release couldn't decode says nothing about
    // whether the next needs converting.
    degraded = false;
    restart({ filename });
  }

  function restart(pick: { audioTrack?: number; filename: string }) {
    if (!session) return;
    report();
    const total = length();
    // Only a position worth carrying. A release refused before it drew a frame sits at zero, and taking that
    // forward would throw away where the library says this was left.
    if (video && total && video.currentTime >= 1)
      startAt = { seconds: video.currentTime, fraction: video.currentTime / total };
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
    report(document.visibilityState === 'hidden' ? HIDDEN_SLACK_SECS : 0);
    hls?.destroy();
    if (session) endSession(session);
  }

  function close() {
    finish();
    onclose();
  }

  // What the lock screen, the system's media controls and a headset's buttons show and do: the title and its poster —
  // the size the poster cards already loaded, and the detail page's — and the video's own transport.
  $effect(() => {
    const element = video;
    if (!element || !('mediaSession' in navigator)) return;
    const media = navigator.mediaSession;
    const poster = title.posterPath;
    media.metadata = new MediaMetadata({
      ...(season !== undefined
        ? { title: `S${season} · E${episode}`, artist: title.title, album: title.title }
        : { title: title.title }),
      artwork: poster
        ? [342, 500].map((width) => ({
            src: `https://image.tmdb.org/t/p/w${width}${poster}`,
            sizes: `${width}x${width * 1.5}`,
            type: 'image/jpeg',
          }))
        : [],
    });
    const seek = (to: number) => {
      const total = length();
      element.currentTime = Math.max(0, total ? Math.min(to, total) : to);
    };
    const handlers: Parameters<typeof media.setActionHandler>[] = [
      ['play', () => void element.play()],
      ['pause', () => element.pause()],
      ['seekbackward', (d) => seek(element.currentTime - (d.seekOffset ?? SKIP_SECS))],
      ['seekforward', (d) => seek(element.currentTime + (d.seekOffset ?? SKIP_SECS))],
      ['seekto', (d) => d.seekTime !== undefined && seek(d.seekTime)],
    ];
    // A browser without a control for an action throws on it rather than ignoring it.
    const set = (...args: Parameters<typeof media.setActionHandler>) => {
      try {
        media.setActionHandler(...args);
      } catch {
        // no such control here
      }
    };
    for (const [action, handler] of handlers) set(action, handler);
    return () => {
      for (const [action] of handlers) set(action, null);
      media.metadata = null;
    };
  });

  $effect(() => {
    untrack(() => void begin());
    // The page behind stays put: it would otherwise scroll under a player that covers it.
    const scrolls = [document.documentElement, document.body].map(
      (el) => [el, el.style.overflow] as const,
    );
    for (const [el] of scrolls) el.style.overflow = 'hidden';
    addEventListener('pagehide', finish);
    return () => {
      for (const [el, overflow] of scrolls) el.style.overflow = overflow;
      removeEventListener('pagehide', finish);
      finish();
    };
  });
</script>

<svelte:window
  onkeydown={(event) => event.key === 'Escape' && !document.fullscreenElement && close()}
/>
<!-- A phone locked or a tab switched away may never come back: where it got to is written as it goes. -->
<svelte:document onvisibilitychange={() => document.visibilityState === 'hidden' && report()} />

<div class="player" role="dialog" aria-modal="true" aria-label={heading}>
  <header>
    <b>{heading}</b>
    <button class="close" aria-label="Close" onclick={close}>
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="m6 6 12 12M18 6 6 18" />
      </svg>
    </button>
  </header>
  <div class="stage">
    {#if failure === 'login'}
      <form onsubmit={letIn}>
        <p>
          Your library’s scout install can only check what’s available, so playing it here needs a
          browser key from the homelab (<code>remux-browser-key.txt</code>) — once; the browser
          keeps it for a month.
        </p>
        <input
          type="password"
          bind:value={key}
          autocomplete="current-password"
          aria-label="Browser key"
        />
        <button class="primary" disabled={!key.trim()}>Let this browser in</button>
        {#if badKey}<p class="error" role="alert">
            That isn’t one of the homelab’s browser keys.
          </p>{/if}
      </form>
    {:else if failure === 'busy' || failure === 'transcode'}
      <p class="note" role="status">{waits[failure]}</p>
    {:else if failure}
      <p class="error" role="alert">{messages[failure]}</p>
    {:else if !session}
      <p class="note">Finding a release this browser can play…</p>
    {:else}
      <!-- den-remux supplies subtitle renditions through the HLS playlist. -->
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
    {@const parts = releaseParts(session)}
    {@const playingTrack = session.audioTracks[session.audioTrack] ?? session.audioTracks[0]}
    {@const downmix = downmixLabel(session)}
    <footer>
      <!-- What plays, then where it came from: two parts of one sentence, so the source moves down whole rather
           than breaking mid-label when there is no room beside it. -->
      <p class="release" aria-live="polite">
        {#if parts.converted}
          <span class="playing">Converted here to {parts.converted}</span>
          <span class="source">from {parts.release}</span>
        {:else}
          <span class="playing">{parts.release}</span>
        {/if}
      </p>
      <div class="controls">
        {#if releases.length > 1}
          <!-- The select is the control, invisible over the whole pill: the browser opens its own menu — a sheet
               on a phone — and a screen reader reads a pop-up button, while the pill draws the icon and the short
               form of what is chosen. -->
          <div class="pick">
            {@render plates()}
            <span class="value" aria-hidden="true"
              >{session.release.label.split('•')[0]?.trim()}</span
            >
            {@render chevron()}
            <select aria-label="Release" value={session.release.filename} onchange={switchRelease}>
              <!-- Keyed by place: two releases can share a file name (the same encode under two infohashes). -->
              {#each releases as release, n (n)}
                <option value={release.filename}>{release.label}</option>
              {/each}
            </select>
          </div>
        {/if}
        {#if session.audioTracks.length > 1 && playingTrack}
          <div class="pick">
            {@render globe()}
            <!-- A track this browser gets with fewer channels says what it gets beside its name, quietly: a known
                 limit of the conversion, not a fault. -->
            <span class="value" aria-hidden="true"
              >{trackLabel(playingTrack, session.audioTrack)}{#if downmix}<span class="downmix"
                  >{downmix}</span
                >{/if}</span
            >
            {@render chevron()}
            <select aria-label="Audio track" value={session.audioTrack} onchange={switchAudio}>
              {#each session.audioTracks as track, n (n)}
                <option value={n}
                  >{trackLabel(track, n)}{downmix && n === session.audioTrack
                    ? ` · ${downmix}`
                    : ''}</option
                >
              {/each}
            </select>
          </div>
        {/if}
        {#if onnext && next}
          {#if upNext !== null}
            <!-- The seconds are kept out of the name: one that changes every second is announced every second. -->
            <button
              class="primary"
              aria-label="Next: {next}"
              onclick={() => {
                stay();
                onnext();
              }}>Next: {next} <span aria-hidden="true">({upNext})</span></button
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

<!-- The Apple TV's own menus mark these with rectangle.stack and globe; the same two, drawn as lines. -->
{#snippet plates()}
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M8 4.5h8" />
    <path d="M6 7.5h12" />
    <rect x="4" y="10.5" width="16" height="9.5" rx="2.5" />
  </svg>
{/snippet}

{#snippet globe()}
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17" />
    <path
      d="M12 3.5c2.4 2.4 3.7 5.3 3.7 8.5s-1.3 6.1-3.7 8.5c-2.4-2.4-3.7-5.3-3.7-8.5s1.3-6.1 3.7-8.5Z"
    />
  </svg>
{/snippet}

{#snippet chevron()}
  <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="m6 9.5 6 6 6-6" />
  </svg>
{/snippet}

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

    /* A tap near the video's own controls acts on them: no text selected under the finger, no grey flash, and no
       double-tap zoom, which a phone otherwise waits for before passing the tap on. */
    user-select: none;
    -webkit-user-select: none;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
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
  .pick {
    flex: 0 0 auto;
    border: 1px solid rgb(255 255 255 / 0.4);
    border-radius: 999px;
    background: none;
    color: #fff;
    font: inherit;
  }

  /* A finger's worth, as every control here is. */
  button {
    min-height: 44px;
    padding: 8px 18px;
    cursor: pointer;
  }

  /* The title takes the width; closing is one glyph, as it is on the pickers. No ring around it: it sits beside
     the title rather than among the controls, and a bordered circle reads heavier than what it does. */
  .close {
    display: grid;
    place-items: center;
    width: 44px;
    padding: 0;
    border-color: transparent;
  }

  /* Where the browser draws the open menu itself, on its own ground. */
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
    gap: 10px 16px;
    align-items: center;
    justify-content: space-between;
    padding-top: 12px;
  }

  .controls {
    display: flex;
    flex: 1 1 auto;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    justify-content: flex-end;
  }

  .note {
    max-width: 50ch;
    color: rgb(255 255 255 / 0.6);
    text-align: center;
  }

  /* The line takes a phone's width to itself and shares a laptop's with the pickers. Its two parts are flex items,
     so the source drops whole to the next line before either of them breaks in the middle. */
  .release {
    display: flex;
    flex: 1 1 16rem;
    flex-wrap: wrap;
    gap: 2px 0.5ch;
    align-items: baseline;
    min-width: 0;
    max-width: 70ch;
    margin: 0;
  }

  .playing {
    color: rgb(255 255 255 / 0.85);
    font-size: 15px;
  }

  /* Where it came from, not what is playing. */
  .source {
    min-width: 0;
    color: rgb(255 255 255 / 0.5);
    font-size: 13px;
  }

  .pick {
    position: relative;
    display: flex;
    flex: 1 1 9rem;
    gap: 8px;
    align-items: center;
    min-width: 0;
    max-width: 18rem;
    min-height: 44px;
    padding: 0 14px;
  }

  /* One picker on a phone gets the row to itself, filling it: at 18rem it sat just short of the width, pushed
     against the right edge. Wider, the row is shared with the release line and 18rem is the right size again. */
  @media (width <= 40rem) {
    .controls > .pick:only-child {
      max-width: none;
    }
  }

  .pick .value {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: 15px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* What the track plays as, beside what it is: as quiet as the release's source. */
  .downmix {
    margin-left: 0.75ch;
    color: rgb(255 255 255 / 0.5);
    font-size: 13px;
  }

  .icon {
    width: 20px;
    height: 20px;
    opacity: 0.75;
  }

  .chevron {
    width: 14px;
    height: 14px;
    opacity: 0.5;
  }

  .icon,
  .chevron {
    flex: 0 0 auto;
    fill: none;
    stroke: currentcolor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .close .icon {
    width: 22px;
    height: 22px;
    opacity: 0.85;
  }

  /* The control itself fills the pill — never hidden, which would stop a phone opening it. */
  .pick select {
    position: absolute;
    inset: 0;
    width: 100%;
    padding: 0;
    border: 0;
    opacity: 0;
    appearance: none;
    cursor: pointer;
  }

  /* The focused element is the select inside, so the pill lights up with it. */
  .pick:focus-within,
  button:focus-visible {
    border-color: var(--accent);
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .error {
    max-width: 50ch;
    color: var(--danger);
    text-align: center;
  }
</style>
