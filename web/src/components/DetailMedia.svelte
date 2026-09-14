<script lang="ts">
  import { onMount } from 'svelte';
  import DetailIcon from './DetailIcon.svelte';
  import type Hls from 'hls.js';
  import { directTrailer, nativeHls, trailerSource, trailerURLs } from '../lib/reel';
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
  /**
   * Whether the direct lookup for the current candidate has settled. Nothing is mounted until it
   * has.
   *
   * Starting reel's copy and swapping to YouTube's when the answer arrived reloaded the element a
   * second or two in, so the trailer visibly restarted just as you began watching it. Waiting costs
   * a round-trip `/meta` has usually already warmed; swapping costs a restart every time.
   */
  let resolved = $state(false);
  const source = $derived(resolved ? (upgraded ?? url) : null);
  /** Does this browser play HLS from a bare element? Asked once: it mounts a video element to find out. */
  const playsHls = nativeHls();
  /**
   * The source this page has to drive itself.
   *
   * A `<video>` given a master playlist it cannot parse simply errors, so where the browser has no
   * native HLS the element is handed nothing and hls.js feeds it instead.
   */
  const managed = $derived(source && !playsHls && source.endsWith('.m3u8') ? source : null);
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
    touched = true;
    const player = video;
    if (!player) return;
    sound = true;
    player.muted = false;
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

  // Straight from YouTube where that is possible, which skips the download, the re-mux and the bytes
  // back out through the house — the whole of the wait before a cold trailer shows anything.
  //
  // This hero carries controls on mobile, so a viewer can turn the sound up: only a source that has
  // sound will do. That is the HLS master where the browser plays it natively, and reel's own MP4
  // everywhere else — never the silent video-only stream, which would play perfectly and say nothing.
  $effect(() => {
    const play = url;
    upgraded = null;
    resolved = false;
    // Both belong to the trailer that is going away, and `sound` especially: left standing it makes
    // the next one autoplay UNMUTED, which every browser refuses — so `play()` is rejected and the
    // trailer sits there paused for no visible reason. Nothing resets it on its own, because a
    // refused full-screen never fires `fullscreenchange` and iOS never fires it at all.
    sound = false;
    touched = false;
    if (!play) return;
    let live = true;
    // Capped, because nothing plays until this settles: a reel that hangs should cost a couple of
    // seconds and then its own copy, rather than the trailer.
    const signal = 'timeout' in AbortSignal ? AbortSignal.timeout(2500) : undefined;
    void directTrailer(play, { signal }).then((direct) => {
      if (!live) return;
      upgraded = trailerSource(play, direct, playsHls);
      resolved = true;
    });
    return () => {
      live = false;
    };
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
      engine = new Hls({ enableWorker: false });
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
    // A direct stream that expired or was withdrawn says nothing about the trailer: reel still holds
    // this one. Drop back to its copy before writing the candidate off and moving to the next.
    if (upgraded) {
      upgraded = null;
      return;
    }
    if (candidate + 1 < candidates.length) candidate += 1;
    else failed = true;
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
