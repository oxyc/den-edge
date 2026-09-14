<script lang="ts">
  import { onMount } from 'svelte';
  import DetailIcon from './DetailIcon.svelte';
  import type Hls from 'hls.js';
  import { hlsURL, isPlaylist, nativeHls, trailerURLs } from '../lib/reel';
  import { memberXhrSetup } from '../lib/relayFetch';
  import type { MediaType } from '../lib/library';
  import type { Routes } from '../lib/routes';
  let {
    type,
    tmdbId,
    imdbId,
    backdrop,
    poster,
    reel,
    routes = {},
    active = true,
    autoplay = true,
  }: {
    type: MediaType;
    /** What reel would rather be asked by, and what every title has — unlike the imdb id. */
    tmdbId?: number;
    imdbId?: string;
    backdrop?: string;
    poster?: string;
    reel?: string | null;
    routes?: Routes;
    active?: boolean;
    autoplay?: boolean;
  } = $props();
  let frame: HTMLDivElement;
  let video = $state<HTMLVideoElement>();
  let candidates = $state<string[]>([]);
  let candidate = $state(0);
  const url = $derived(candidates[candidate] ?? null);
  /** YouTube's own URL for this candidate, when one exists that this browser can play. */
  let upgraded = $state<string | null>(null);
  const source = $derived(upgraded ?? url);
  /** Does this browser play HLS from a bare element? Asked once: it mounts a video element to find out. */
  const playsHls = nativeHls();
  /**
   * The source this page has to drive itself.
   *
   * A `<video>` given a master playlist it cannot parse simply errors, so where the browser has no
   * native HLS the element is handed nothing and hls.js feeds it instead.
   *
   * The test is on the PATH, and has to be: reel signs its play links, so an HLS URL ends
   * `…m3u8?s=<tag>`, and asking whether the whole URL ended in `.m3u8` was false for every one of
   * them. hls.js was never started, the element was handed a playlist to parse by itself, and each
   * browser errored its way back to reel's `/play` download — the very path this exists to avoid.
   */
  const managed = $derived(source && !playsHls && isPlaylist(source) ? source : null);
  let visible = $state(true);
  let foreground = $state(!document.hidden);
  let reduced = $state(matchMedia('(prefers-reduced-motion: reduce)').matches);
  let mobile = $state(matchMedia('(max-width: 759px)').matches);
  let playing = $state(false);
  let ended = $state(false);
  let failed = $state(false);
  /**
   * Set when the viewer asks for the trailer full-screen, and the only thing that lets it make a
   * sound. Autoplay with audio cannot be granted — every browser refuses it without a gesture, and
   * hardware volume keys never reach the page — so the click that expands is the gesture.
   */
  let sound = $state(false);
  /**
   * Whether the viewer has touched this trailer yet. The native controls are held back until they
   * have: unasked-for chrome over a hero is a play button and a scrubber sitting on the artwork, and
   * on a paused element iOS draws that play button across the middle of the picture.
   */
  let touched = $state(false);

  /**
   * A tap brings up the controls and turns the sound on together.
   *
   * The tap is a gesture, and a gesture is the only thing that may unmute anything — so the moment a
   * viewer reaches for this trailer is the one moment we are allowed to give them its audio.
   */
  function tap() {
    const player = video;
    if (!player) return;
    // Once, and only once. After the first tap the native controls are showing, and they sit INSIDE the
    // element — so a tap on their pause button is also a click on the video, and calling play() here
    // again fought the viewer for it: the trailer stopped for a moment and started itself back up. The
    // first tap is the gesture that earns sound; from then on the element is theirs to drive.
    if (touched) return;
    touched = true;
    sound = true;
    player.muted = false;
    void player.play().catch(() => {});
  }

  /**
   * Try again once the element actually has data.
   *
   * WebKit refuses `play()` on an element it does not yet consider ready, and the effect that starts
   * playback re-runs only when `allowed` or the source changes — so a refusal was final, and the
   * trailer sat on its poster until someone tapped it. It used to get away with this by accident: the
   * source arrived a second or two late, behind a `/direct` round trip, by which time the element was
   * ready. Asking again here is what that delay was doing.
   *
   * Never against the viewer: `touched` means they have the controls, and a paused trailer they paused
   * stays paused. Never an ended one either — `play()` on an ended element starts it again from the
   * beginning, and a trailer that has finished must stay finished. That one is a race, not a rarity: a
   * `canplay` arriving as the media ends sees `paused` already true and `ended` not yet read, so the
   * retry would resurrect the trailer a moment after it stopped.
   */
  function start() {
    const player = video;
    if (!player || touched || !allowed || !player.paused || player.ended) return;
    void player.play().catch(() => {});
  }

  /** Take over the screen, with the audio on. */
  async function expand() {
    const player = video;
    if (!player) return;
    sound = true;
    player.muted = false;
    // iOS ignores this (volume is read-only there); unmuting is what carries the sound.
    player.volume = 1;
    // Back to a quiet page on the way out: a trailer still talking after the viewer closed it is
    // the thing they would then have to go and silence.
    const leave = () => {
      if (document.fullscreenElement) return;
      sound = false;
      player.muted = true;
      document.removeEventListener('fullscreenchange', leave);
    };
    document.addEventListener('fullscreenchange', leave);
    try {
      if (player.requestFullscreen) await player.requestFullscreen();
      else
        (
          player as HTMLVideoElement & { webkitEnterFullscreen?: () => void }
        ).webkitEnterFullscreen?.();
    } catch {
      // Refused, or unsupported: `leave` will never fire, so take it back off rather than leave a
      // listener behind for every press. The sound stays on — the click that asked for it is gesture
      // enough to play unmuted where it is — and the next trailer resets it.
      document.removeEventListener('fullscreenchange', leave);
    }
    void player.play().catch(() => {});
  }
  const saving = Boolean(
    (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData,
  );
  const allowed = $derived(
    autoplay && active && visible && foreground && !reduced && !saving && !ended && !failed,
  );

  onMount(() => {
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const small = matchMedia('(max-width: 759px)');
    const preferences = () => {
      reduced = motion.matches;
      mobile = small.matches;
    };
    const visibility = () => {
      foreground = !document.hidden;
    };
    // The LAST entry, not the first. Leaving this page and coming back queues several, and taking
    // `entries[0]` took the oldest of them — a stale `false` from while the page was hidden — after
    // which nothing fires again, because the real intersection state never changes a second time.
    // That is the trailer that comes back from a swipe and sits there paused for good.
    const observer = new IntersectionObserver((entries) => {
      visible = entries[entries.length - 1]?.isIntersecting ?? false;
    });
    observer.observe(frame);
    motion.addEventListener('change', preferences);
    small.addEventListener('change', preferences);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      observer.disconnect();
      motion.removeEventListener('change', preferences);
      small.removeEventListener('change', preferences);
      document.removeEventListener('visibilitychange', visibility);
    };
  });

  $effect(() => {
    const [ids, base, mediaType, table] = [{ tmdb: tmdbId, imdb: imdbId }, reel, type, routes];
    candidates = [];
    candidate = 0;
    playing = ended = failed = false;
    if (!autoplay || !active || reduced || saving || (!ids.tmdb && !ids.imdb) || !base) return;
    const controller = new AbortController();
    // Resolve only. YouTube's adaptive stream carries sound and plays in every browser now — its
    // master directly where HLS is native, reel's proxy of it everywhere else — so a download and
    // remux would only warm a fallback that is not normally reached.
    void trailerURLs(base, mediaType, ids, table, {
      signal: controller.signal,
      prewarm: 'direct',
    }).then((found) => {
      if (!controller.signal.aborted) candidates = found;
    });
    return () => controller.abort();
  });

  // YouTube's adaptive master through reel, which skips the download, the re-mux and the bytes back
  // out through the house — the whole of the wait before a cold trailer shows anything.
  //
  // The source follows from the play URL alone, so it is known on the first render. Asking `/direct`
  // first, only to learn whether a master exists, put a round trip and a yt-dlp resolve in front of
  // every trailer with the element held empty for both; the one case it ruled out — a trailer with
  // no master — is a 404 the error path already reads as "fall back to reel's own file".
  $effect(() => {
    const play = url;
    // Both belong to the trailer that is going away, and `sound` especially: left standing it makes
    // the next one autoplay UNMUTED, which every browser refuses — so `play()` is rejected and the
    // trailer sits there paused for no visible reason. Nothing resets it on its own, because a
    // refused full-screen never fires `fullscreenchange` and iOS never fires it at all.
    sound = false;
    touched = false;
    upgraded = play ? hlsURL(play, playsHls) : null;
  });

  // MSE, where the browser will not play a playlist itself. hls.js takes the element rather than a
  // `src`, and is torn down with the source it was given — switching candidates must never leave two
  // engines feeding one element. A master that will not play falls back to reel's own file, which is
  // what `upgraded = null` selects.
  $effect(() => {
    const player = video;
    const master = managed;
    if (!player || !master) return;
    let live = true;
    let engine: Hls | undefined;
    void import('hls.js').then(({ default: Hls }) => {
      if (!live) return;
      if (!Hls.isSupported()) {
        upgraded = null;
        return;
      }
      // The membership claim travels on hls.js's own requests too, or a paired household counts as a
      // guest against the relay's guest budget — on its own box, from its own sofa.
      // Open near the top of the ladder instead of climbing to it. hls.js assumes 500 kbps until it has
      // measured a fragment, and `testBandwidth` makes it start lower still to take that measurement —
      // which on a ninety-second trailer spends the part anyone actually watches at the bottom of a
      // ladder that reaches 1080p. The estimate is the home connection these are served over; ABR still
      // measures every fragment and drops if the line cannot hold it.
      engine = new Hls({
        enableWorker: false,
        xhrSetup: memberXhrSetup,
        abrEwmaDefaultEstimate: 5_000_000,
        testBandwidth: false,
      });
      engine.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) upgraded = null;
      });
      // The element is mounted with no `src`, so the effect that starts playback has already run and
      // found nothing to play. Autoplay begins here, once there is something to begin.
      engine.on(Hls.Events.MANIFEST_PARSED, () => {
        if (allowed) void player.play().catch(() => {});
      });
      engine.loadSource(master);
      engine.attachMedia(player);
    });
    return () => {
      live = false;
      engine?.destroy();
    };
  });

  // Reads `source`, not `url`, and that is the whole point: swapping `src` to the direct stream
  // pauses the element, so an effect watching only `url` never runs again and the trailer sits there
  // loaded and still. It has to re-run for whichever source is actually mounted.
  $effect(() => {
    const player = video;
    const canPlay = allowed && !!source;
    if (!player) return;
    if (!canPlay) {
      player.pause();
      playing = false;
      return;
    }
    let live = true;
    player.muted = !sound;
    void player
      .play()
      .then(() => {
        if (live) firstFrame();
      })
      .catch(() => {
        if (live) playing = false;
      });
    return () => {
      live = false;
      player.pause();
    };
  });

  function metadata() {
    if (!video) return;
    // Keep the trailer at its actual beginning. Seeking during metadata loading can defer
    // WebKit's first painted frame while the audio/video clock is already advancing.
    if (video.videoHeight > video.videoWidth) nextTrailer();
  }
  function nextTrailer() {
    if (!url || !active) return;
    playing = false;
    // The next candidate's master before this one's file. A master refused because YouTube has removed
    // the video is refused for reel's copy too — and asking costs a whole yt-dlp round trip to be told
    // the same thing: two seconds for the master, nearly two more for the file, before a trailer that
    // does exist is even started. So walk the candidates first.
    if (candidate + 1 < candidates.length) {
      candidate += 1;
      return;
    }
    // Every master refused. reel's own file is what is left, and it is worth one ask: a video with no
    // HLS master at all still plays from it. Once, not once per candidate.
    if (upgraded) {
      upgraded = null;
      return;
    }
    failed = true;
  }
  function firstFrame() {
    const player = video;
    // An opacity-zero video may not receive compositor callbacks on mobile. Decoder readiness
    // and playback events can reveal it without waiting for the hidden layer to be painted.
    if (
      player &&
      allowed &&
      player.readyState >= 2 &&
      !player.seeking &&
      !player.paused &&
      !player.ended
    )
      playing = true;
  }
</script>

<div class="media" bind:this={frame} data-detail-media>
  {#if backdrop || poster}
    <img class="backdrop" class:portrait={!backdrop} src={backdrop ?? poster} alt="" />
  {/if}
  <!-- Always mounted: a late URL or first frame cannot insert space into the detail layout. -->
  <video
    bind:this={video}
    src={managed ? undefined : (source ?? undefined)}
    class:playing
    class:present={!!source && !failed && !ended}
    poster={backdrop ?? poster}
    muted
    playsinline
    preload={allowed ? 'auto' : 'metadata'}
    controls={mobile && touched && !!source && !failed}
    onclick={tap}
    aria-label="Trailer"
    aria-hidden={!mobile}
    onloadedmetadata={metadata}
    oncanplay={start}
    onloadeddata={firstFrame}
    onseeked={firstFrame}
    ontimeupdate={firstFrame}
    onplaying={firstFrame}
    onplay={() => {
      ended = false;
    }}
    onended={() => {
      ended = true;
      playing = false;
    }}
    onerror={nextTrailer}
    onloadstart={(event) => {
      event.currentTarget.muted = !sound;
    }}
  ></video>
  <div class="scrim" aria-hidden="true"></div>
  <!-- Glass, because this is a control over media — the one place the look is for. Desktop only:
       a phone already gets the video's own controls, and its full-screen is a tap on those. -->
  {#if !mobile && !!source && !failed && !ended}
    <button class="expand glass" onclick={expand} aria-label="Play trailer full screen with sound">
      <DetailIcon name="expand" />
    </button>
  {/if}
</div>

<style>
  .media {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--bg);

    /* The same name the billboard's picture carries, so opening a title morphs one into the other
       instead of cross-fading the whole page through it. Coming back is smooth because Home is never
       unmounted and its trailer never stopped; going forward there is no page to reuse, and this is
       the nearest thing — the browser animates the outgoing trailer's last painted frame into this
       hero, which is already showing the same backdrop. Only one of the two is ever rendered at a
       time (the inactive page is `hidden`), so the name cannot collide. */
    view-transition-name: den-hero-media;
    contain: layout;
  }

  .backdrop,
  video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .portrait {
    filter: blur(24px);
    transform: scale(1.12);
    opacity: 0.65;
  }

  /* Let the browser replace its own poster with the first decoded frame. An opacity-zero
     video can be held off by WebKit's visibility/autoplay heuristics, creating a hidden-player loop. */
  video {
    opacity: 0;
    background: #000;
    pointer-events: none;
  }

  video.present {
    opacity: 1;
  }

  .scrim {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
      linear-gradient(to top, var(--bg), rgb(0 0 0 / 0.15) 75%),
      linear-gradient(to right, rgb(0 0 0 / 0.45), transparent 80%);
  }

  .expand {
    position: absolute;
    top: calc(var(--bar-space) + 12px);
    right: var(--gutter);
    z-index: 1;
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    padding: 0;
    border-radius: 999px;
    color: var(--fg);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.2s ease;
  }

  /* Before the hover rule, which is the more specific of the two: a control reached by keyboard has
     to show itself without waiting for a pointer that may never arrive. */
  .expand:focus-visible {
    opacity: 1;
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }

  /* Otherwise it appears with the picture it belongs to. */
  .media:hover .expand {
    opacity: 1;
  }

  @media (prefers-reduced-motion: reduce) {
    .expand {
      transition: none;
    }
  }

  @media (width <= 759px) {
    video {
      object-fit: contain;
    }

    video.present {
      pointer-events: auto;
    }

    .scrim {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    video {
      transition: none;
    }
  }
</style>
