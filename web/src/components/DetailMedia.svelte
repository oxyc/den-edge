<script lang="ts">
  import { onMount } from 'svelte';
  import DetailIcon from './DetailIcon.svelte';
  import type Hls from 'hls.js';
  import { hlsURL, isPlaylist, nativeHls, trailerURLs } from '../lib/reel';
  import { memberXhrSetup } from '../lib/relayFetch';
  import type { MediaType } from '../lib/library';
  import type { Routes } from '../lib/routes';
  import { started } from '../lib/mediaProbe';
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
   * Whether this source has already been asked to load explicitly, after a refused `play()`.
   *
   * Once per source, because `load()` resets the element: asking twice would be a loop of reloads, each
   * refused for the same reason as the first.
   */
  let forced = $state(false);

  /**
   * A tap brings up the controls and turns the sound on together.
   *
   * The tap is a gesture, and a gesture is the only thing that may unmute anything — so the moment a
   * viewer reaches for this trailer is the one moment we are allowed to give them its audio.
   */
  function tap() {
    const player = video;
    if (!player) return;
    if (!pressed) return;
    pressed = false;
    // Once, and only once. After the first tap the native controls are showing, and they sit INSIDE the
    // element — so a tap on their pause button is also a click on the video, and calling play() here
    // again fought the viewer for it: the trailer stopped for a moment and started itself back up. The
    // first tap is the gesture that earns sound; from then on the element is theirs to drive.
    if (touched) return;
    touched = true;
    sound = true;
    quieten(player);
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
    // Silence is re-asserted rather than assumed: this is the one path that starts playback without having
    // set it, so a stray unmute from anywhere else corrects itself at the next `canplay` instead of being
    // carried into the picture.
    quieten(player);
    void player.play().catch(() => {});
  }

  /**
   * Whether the press about to become a click actually began on this page.
   *
   * Opening a title from Home left its trailer playing out loud, and only that way round — the same page
   * loaded from its own URL is silent. So the press that asks for the page arrives at the page it asked for,
   * and lands on whatever this hero has just put under the pointer: below 760px that is the video itself,
   * which is a tap, and a tap is what grants audio.
   *
   * Provenance rather than timing. A click inherited from the page before has no `pointerdown` here, because
   * the press began on the billboard; a real tap has both. A window of milliseconds would have had to be
   * long enough to cover a navigation and short enough not to swallow somebody tapping quickly, and there is
   * no such number — a 400ms one ate the tap that brings up the controls.
   */
  let pressed = false;

  /**
   * Silence, said twice — and the second way is the one that works here.
   *
   * A trailer opened from the billboard played out loud on macOS Safari while the element reported `muted`
   * true at every moment it was measured: 0.7s, 2.5s and 6s in, playing, attached, with the only other media
   * on the page paused and frozen. So the property was not carrying the intent, and three fixes that set it
   * correctly changed nothing. `volume` is set with it now, and the two together are what keep it quiet.
   *
   * Both directions go through here, so granting sound and taking it back are the same decision read from
   * `sound` rather than two places that can disagree.
   */
  /** WebKit's handle on a master's separate audio rendition. Absent in every other browser. */
  type Renditions = { length: number; [at: number]: { enabled: boolean } };

  function renditions(player: HTMLMediaElement): Renditions | undefined {
    return (player as HTMLMediaElement & { audioTracks?: Renditions }).audioTracks;
  }

  function quieten(player: HTMLMediaElement) {
    player.muted = !sound;
    player.volume = sound ? 1 : 0;
    // reel's masters carry `EXT-X-MEDIA:TYPE=AUDIO`, and Safari hands such a master to AVFoundation,
    // which plays that rendition through a path neither `muted` nor `volume` reaches: the element
    // reports silence while the sound comes out of it. Switching the rendition itself off is what stops
    // it. It does not exist until metadata has been read, so this runs again on `loadedmetadata`.
    const tracks = renditions(player);
    if (!tracks) return;
    for (let at = 0; at < tracks.length; at += 1) {
      const track = tracks[at];
      if (track) track.enabled = sound;
    }
  }

  /** Take over the screen, with the audio on. */
  async function expand() {
    const player = video;
    if (!player) return;
    if (!pressed) return;
    pressed = false;
    sound = true;
    // iOS treats volume as read-only, so unmuting is what carries the sound there; everywhere else both go.
    quieten(player);
    // Back to a quiet page on the way out: a trailer still talking after the viewer closed it is
    // the thing they would then have to go and silence.
    const leave = () => {
      if (document.fullscreenElement) return;
      sound = false;
      quieten(player);
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
      // Refused, or unsupported: `leave` will never fire, so take it back off rather than leave a listener
      // behind for every press — and go back to silence. Keeping the sound on here was how a trailer began
      // talking on a page nobody had pressed anything on: this control is a 44px circle at the hero's top
      // right, drawn at opacity 0, which still takes clicks, and it sits exactly where the billboard's own
      // expand button is on the page you just left. A click aimed there that lands here after the
      // navigation has already spent its gesture gets full screen refused and, before this, audio anyway.
      sound = false;
      quieten(player);
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

  // TEMPORARY — remove once the Safari sound is identified.
  //
  // Three fixes have aimed at this hero's own controls and none has stopped a trailer arriving with audio when
  // a title is opened from the billboard. Every one of them assumed which element was making the noise, and
  // that assumption has never been checked. So this names them all instead: a second after the page appears,
  // every media element on it, how it is set, and what this component thinks it granted. It asks nothing of
  // the viewer and reports no data anywhere — one console line, read once, then gone.
  onMount(() => {
    // The first probe answered one question and raised a sharper one: two video elements carry the same
    // trailer, one of them playing, and BOTH report themselves muted while sound is audible. So either a
    // muted element is not silent, or the one making the noise is not in the document — a detached media
    // element keeps playing in WebKit, and the first probe only enumerated what was attached.
    //
    // Emptying `<body>` by hand left the sound playing, which settles it: the emitter is not in the
    // document, and no walk of the document can reach it. So this reads the registry instead — every
    // element that ever called `play()`, attached or not — and names the stack that started each one.
    const look = (at: number) => {
      // A scratch array rather than a Set: this wants no reactivity, and a component may not hold a
      // plain Set.
      const seen: HTMLMediaElement[] = [];
      const media: unknown[] = [];
      const describe = (player: HTMLMediaElement, from: string) => {
        if (seen.includes(player)) return;
        seen.push(player);
        const where = player.closest('[data-detail-media]')
          ? 'detail'
          : player.classList.contains('ambient')
            ? 'billboard'
            : 'other';
        const list = renditions(player);
        media.push({
          where,
          connected: player.isConnected,
          tracks: list
            ? Array.from({ length: list.length }, (_, at) => list[at]?.enabled ?? null)
            : null,
          muted: player.muted,
          paused: player.paused,
          volume: player.volume,
          time: Number(player.currentTime.toFixed(1)),
          src: (player.currentSrc || player.src).slice(-48),
          from: from.split('\n').slice(1, 4).join(' | ').slice(0, 180),
        });
      };
      started.forEach((entry) => describe(entry.element, entry.from));
      document
        .querySelectorAll('video, audio')
        .forEach((element) => describe(element as HTMLMediaElement, 'attached, never played'));
      console.log('[den audio probe]', JSON.stringify({ at, sound, touched, media }));
    };

    /**
     * Both players report silence on every lever they have — muted, volume 0, renditions off — and the
     * sound goes on, so the thing making it answers to none of them. In WebKit the only certain way to
     * stop an item AVFoundation has started is to destroy the source under it. Each is torn down in turn,
     * at a known moment, and which moment the sound stops at says which player was carrying it. If it
     * survives both, it belongs to neither and the search moves off these elements entirely.
     */
    const tearDown = (player: HTMLVideoElement | null, whose: string) => {
      if (!player) return;
      player.pause();
      player.removeAttribute('src');
      player.load();
      console.log('[den audio probe] torn down:', whose);
    };
    const timers = [700, 2500, 6000].map((at) => setTimeout(() => look(at), at));
    timers.push(
      setTimeout(
        () => tearDown(document.querySelector<HTMLVideoElement>('video.ambient'), 'billboard'),
        6500,
      ),
      setTimeout(() => tearDown(video ?? null, 'detail'), 9000),
    );
    return () => timers.forEach((timer) => clearTimeout(timer));
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
    forced = false;
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
      // Open on the rung carrying the most bits, found by MEASURE rather than by position: an index is not
      // a ranking, because hls.js orders `levels` for itself whatever order the master lists them in.
      // Naming level 0 therefore asked for the WORST rung. ABR takes over once a fragment is in.
      engine.on(Hls.Events.MANIFEST_PARSED, () => {
        const levels = engine?.levels ?? [];
        const best = levels.reduce(
          (top, level, at) => (level.bitrate > (levels[top]?.bitrate ?? 0) ? at : top),
          0,
        );
        if (engine && levels.length > 1) engine.nextLevel = best;
        // The element is mounted with no `src`, so the effect that starts playback has already run and
        // found nothing to play. Autoplay begins here, once there is something to begin.
        if (allowed) void player.play().catch(() => {});
      });
      engine.on(Hls.Events.FRAG_BUFFERED, () => {
        // The opening rung was ours; every one after it is the line's to choose.
        if (engine) engine.nextLevel = -1;
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
    quieten(player);
    void player
      .play()
      .then(() => {
        if (live) firstFrame();
      })
      .catch(() => {
        if (!live) return;
        playing = false;
        // A refusal is not always final, and on iOS it was being made final by accident. `preload` is
        // commonly ignored there, so an element whose `play()` was refused may never load at all — and
        // then `canplay` never fires, `start` never runs, and the trailer waits for a tap that may
        // never come. Asking for the data outright gives that retry something to happen on. Once per
        // source, and still through `play()`, so a test can intercept every attempt.
        if (!forced) {
          forced = true;
          player.load();
        }
      });
    return () => {
      live = false;
      player.pause();
    };
  });

  function metadata() {
    if (!video) return;
    // A master's audio renditions do not exist until metadata has been read, so every earlier attempt at
    // silence had nothing to switch off. This is the first point at which it can be made to stick.
    quieten(video);
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
  <!-- Always mounted: a late URL or first frame cannot insert space into the detail layout.

       Playback is started by `play()` alone, never by an `autoplay` attribute. The attribute looked like
       the fix for iOS — Home's billboard carries one — but it starts the element without calling
       `play()`, which walks straight past the one test that proves a blocked autoplay leaves the poster
       up and the video paused. A behaviour no test can intercept is one that breaks quietly later. -->
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
    onpointerdown={() => (pressed = true)}
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
      quieten(event.currentTarget);
    }}
  ></video>
  <div class="scrim" aria-hidden="true"></div>
  <!-- Glass, because this is a control over media — the one place the look is for. Desktop only:
       a phone already gets the video's own controls, and its full-screen is a tap on those. -->
  {#if !mobile && !!source && !failed && !ended}
    <button
      class="expand glass"
      onpointerdown={() => (pressed = true)}
      onclick={expand}
      aria-label="Play trailer full screen with sound"
    >
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
