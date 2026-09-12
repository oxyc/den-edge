<script lang="ts">
  import { onMount } from 'svelte';
  import { trailerURLs } from '../lib/reel';
  import type { MediaType } from '../lib/library';
  import type { Routes } from '../lib/routes';
  let {
    type,
    imdbId,
    backdrop,
    poster,
    reel,
    routes = {},
    active = true,
    autoplay = true,
  }: {
    type: MediaType;
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
  let visible = $state(true);
  let foreground = $state(!document.hidden);
  let reduced = $state(matchMedia('(prefers-reduced-motion: reduce)').matches);
  let mobile = $state(matchMedia('(max-width: 759px)').matches);
  let playing = $state(false);
  let ended = $state(false);
  let failed = $state(false);
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
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
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
    const [id, base, mediaType, table] = [imdbId, reel, type, routes];
    candidates = [];
    candidate = 0;
    playing = ended = failed = false;
    if (!autoplay || !active || reduced || saving || !id || !base) return;
    const controller = new AbortController();
    void trailerURLs(base, mediaType, id, table, { signal: controller.signal }).then((found) => {
      if (!controller.signal.aborted) candidates = found;
    });
    return () => controller.abort();
  });

  $effect(() => {
    const player = video;
    const canPlay = allowed && !!url;
    if (!player) return;
    if (!canPlay) {
      player.pause();
      playing = false;
      return;
    }
    let live = true;
    player.muted = true;
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
    src={url ?? undefined}
    class:playing
    class:present={!!url && !failed && !ended}
    poster={backdrop ?? poster}
    muted
    playsinline
    preload={allowed ? 'auto' : 'metadata'}
    controls={mobile && !!url && !failed}
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
      event.currentTarget.muted = true;
    }}
  ></video>
  <div class="scrim" aria-hidden="true"></div>
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
