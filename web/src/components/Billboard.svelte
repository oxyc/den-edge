<!-- Home's billboard: full-bleed, running up behind the bar, cycling every fifteen seconds.

     The words are a scroller and the picture is not. Sliding whole slides — picture and all — drags a hard
     vertical join across the screen, two photographs butted edge to edge; snapping between them is a lovely
     gesture and an ugly transition. So the rail carries only the words, where sliding is exactly right, and
     behind it one continuous picture dissolves from title to title, which is what a billboard changing its mind
     should look like. The swipe is still the browser's own: momentum, rubber-banding, trackpads, all free.

     The slide's trailer plays quietly behind it once it has settled, as the TV's hero does — muted, no chrome,
     nothing to press. It is decoration, so it gives way whenever it would cost more than it gives: Reduce
     Motion, Data Saver, or the billboard scrolled off the screen leave the still picture in its place. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import DetailIcon from './DetailIcon.svelte';
  import { stableViewportHeight } from '../lib/stableViewportHeight';
  import { fetchDetail, type TitleDetail } from '../lib/detail';
  import type { Title } from '../lib/library';
  import type Hls from 'hls.js';
  import { hlsURL, isPlaylist, nativeHls, trailerURL } from '../lib/reel';
  import { memberXhrSetup } from '../lib/relayFetch';
  import { titleHref } from '../lib/route';
  import type { Routes } from '../lib/routes';

  let {
    titles,
    active = true,
    tmdbKey,
    onplay,
    reel,
    routes,
  }: {
    /** The billboard's titles, best first. */
    titles: Title[];
    active?: boolean;
    tmdbKey: string;
    /** Play it in this browser; no button without it. */
    onplay?: (title: Title) => void;
    /** Where this page asks den-reel (`/reel/<config>`); without it a slide keeps its still picture. */
    reel?: string | null;
    /** The routes table, for the address the trailer's video is loaded from. */
    routes?: Routes;
  } = $props();

  /** As many as the TV's hero carries. */
  const SLIDES = 40;
  const ADVANCE_MS = 15_000;
  /** At most this many dots, sliding to keep the current one in view: forty bullets is a bar, not a pager. */
  const DOT_WINDOW = 9;
  /**
   * How long a slide stands still before its trailer is even LOOKED UP: paging past five shouldn't
   * resolve five of them.
   *
   * It used to be two seconds, and it gated the lookup and the playback together — so the slide sat
   * doing nothing for two seconds and only then began a resolve that takes about a second itself,
   * and a first frame that takes longer. Nothing needs the wait twice: the lookup is its own delay
   * before anything can play, so this only has to be long enough to skip the slides being flicked
   * past.
   */
  const SETTLE_MS = 500;

  const shown = $derived(titles.slice(0, SLIDES));
  let index = $state(0);
  /** Set once you move it by hand: from then on it holds still and is yours to drive. */
  let paging = $state(false);
  let held = $state(false);
  const current = $derived(shown[Math.min(index, shown.length - 1)]);
  const firstTitleKey = $derived(shown[0] ? `${shown[0].type}:${shown[0].id}` : '');

  const keyOf = (title: Title) => `${title.type}:${title.id}`;
  const backdropURL = (path: string) => `https://image.tmdb.org/t/p/w1280${path}`;
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Details arrive per slide and are kept, so coming back to one shows it at once.
  let known = $state(new Map<string, TitleDetail>());

  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- In-flight deduplication must not retrigger the effect that schedules lookups.
  const learning = new Set<string>();

  async function learn(title: Title | undefined): Promise<void> {
    if (!title || !tmdbKey || known.has(keyOf(title)) || learning.has(keyOf(title))) return;
    const key = keyOf(title);
    learning.add(key);
    try {
      const found = await fetchDetail({ type: title.type, id: title.id }, tmdbKey).catch(
        () => null,
      );
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Publish one completed immutable map through the existing state assignment.
      if (found) known = new Map(known).set(key, found);
    } finally {
      learning.delete(key);
    }
  }

  const detail = $derived(current ? known.get(keyOf(current)) : undefined);

  // Two either way rather than one: a slide whose details haven't arrived has no picture to show, so the reach
  // of this is how often the billboard goes dark for a moment when someone swipes briskly.
  $effect(() => {
    for (const step of [0, 1, -1, 2, -2]) void learn(shown[index + step]);
  });

  // --- The picture ---

  /**
   * Two layers that take turns. The one coming in fades up over the one going out, which is a dissolve without
   * asking the framework for a transition — a plain CSS opacity change the compositor can run on its own.
   */
  let layers = $state([
    { id: 0, url: '' },
    { id: 1, url: '' },
  ]);
  let lit = $state(0);

  /** The picture this slide should be showing; anything that finishes loading after this changed is stale. */
  let wanted = '';

  $effect(() => {
    const path = current?.backdropPath ?? detail?.backdropPath;
    const url = path ? backdropURL(path) : '';
    // Warm the neighbours, so paging usually finds the picture already decoded and swaps without a gap.
    for (const step of [1, -1]) {
      const near = shown[index + step];
      const path = near && (near.backdropPath ?? known.get(keyOf(near))?.backdropPath);
      if (path) {
        const image = new Image();
        image.fetchPriority = 'low';
        image.src = backdropURL(path);
      }
    }
    untrack(() => {
      if (lit >= 0 && layers[lit]?.url === url) return;
      wanted = url;
      // Nothing is lit while the right picture is on its way. Keeping the last one up would show one title's
      // artwork behind another title's name — which is the same picture appearing twice, once against the
      // wrong words. The scrim carries the words for the moment it takes.
      lit = -1;
      if (!url) return;
      const image = new Image();
      image.fetchPriority = 'high';
      image.onload = () => {
        // The slide may have moved on while this loaded, and a slow picture must not overwrite a later one.
        if (wanted !== url) return;
        const next = layers[0]?.url === url ? 0 : 1;
        layers[next] = { id: next, url };
        lit = next;
      };
      image.src = url;
    });
  });

  /** The trailer playing behind the current slide, once it has earned it; null while the still picture stands. */
  let ambient = $state<string | null>(null);
  /** Held back until the video says it is running: a slide should never go blank waiting for one. */
  let playing = $state(false);
  let frame = $state<HTMLElement>();
  let onScreen = $state(true);
  /** A hidden tab is still "intersecting", so the observer below never fires when you switch away from it. */
  let foreground = $state(!document.hidden);
  let ambientPlayer = $state<HTMLVideoElement>();
  /** A trailer den-reel cannot serve — YouTube refuses some of them to a server — is not asked for again. */
  let ambientFailed = $state(false);
  /** reel's own copy, kept behind YouTube's URL: what to fall back to if the direct stream won't play. */
  let proxied = $state<string | null>(null);
  /** Does this browser play HLS from a bare element? Asked once: it mounts a video element to find out. */
  const playsHls = nativeHls();
  /**
   * The source this page has to drive itself: a `<video>` handed a master playlist it cannot parse
   * only errors, so where there is no native HLS the element gets nothing and hls.js feeds it.
   *
   * By the PATH. reel signs its play links, so a playlist URL ends `…m3u8?s=<tag>`, and a suffix
   * test called every one of them not-a-playlist: hls.js never started and the slide fell back to
   * reel's `/play` download.
   */
  const managed = $derived(ambient && !playsHls && isPlaylist(ambient) ? ambient : null);

  /** This source will not play: reel's own copy, and then the still picture, are what is left. */
  function ambientFailedOver() {
    playing = false;
    // YouTube's own URL can expire or be withdrawn under us; reel's copy is what to try before
    // giving up on the slide altogether.
    if (proxied && ambient !== proxied) {
      ambient = proxied;
      return;
    }
    // The still picture is the fallback, and asking again on every return only fills reel's log.
    ambient = null;
    ambientFailed = true;
  }
  /** Someone paying by the megabyte hasn't asked for a video they didn't press. */
  const saving = () =>
    Boolean(
      (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData,
    );

  // A trailer playing under the rows, heard by nobody and seen by nobody, is battery and data spent on nothing.
  $effect(() => {
    const box = frame;
    if (!box || typeof IntersectionObserver === 'undefined') return;
    // The last entry, not the first: leaving Home and returning queues several, and the oldest is a
    // stale `false` that would leave the billboard's trailer stopped with nothing left to restart it.
    const watch = new IntersectionObserver(
      (entries) => (onScreen = entries[entries.length - 1]?.isIntersecting ?? true),
      { threshold: 0 },
    );
    watch.observe(box);
    return () => watch.disconnect();
  });

  // Switching tabs moves nothing on the page, so the observer above stays silent while the video plays on to
  // an empty room. Nothing is heard — it is muted — but the decoding and the data are spent all the same.
  $effect(() => {
    const seen = () => (foreground = !document.hidden);
    document.addEventListener('visibilitychange', seen);
    return () => document.removeEventListener('visibilitychange', seen);
  });

  /** The trailer belongs to the slide, and is dropped when the slide changes — not when it goes out of view. */
  $effect(() => {
    void current;
    ambient = null;
    proxied = null;
    playing = false;
    ambientFailed = false;
  });

  $effect(() => {
    const title = current;
    const imdbId = detail?.imdbId;
    const base = reel;
    const table = routes;
    // No imdb id required any more: reel is asked by the tmdb id every title carries, and told the imdb
    // one only when this slide's details have arrived carrying it.
    if (!active || !title || !base || !onScreen || still() || saving() || ambientFailed) return;
    // Already found for this slide: scrolling back must resume it, not fetch it and sit out the settle again.
    if (untrack(() => ambient)) return;
    let live = true;
    const timer = setTimeout(() => {
      // Resolve only. Every browser plays YouTube's adaptive stream through reel's `/hls` — the
      // playlist reordered, and the segments still fetched from Google wherever a bare element can
      // fetch them itself — so asking reel to download and remux the whole file buys a fallback
      // nothing normally reaches, at a minute of its CPU.
      void trailerURL(base, title.type, { tmdb: title.id, imdb: imdbId }, table ?? {}, {
        prewarm: 'direct',
      }).then((url) => {
        if (!live || !url) return;
        // Asking reel for the URL costs a lookup; asking it for the file costs a download, an ffmpeg
        // re-mux, a slot on the cache volume and the trailer crossing the house twice — which is the
        // whole wait before a cold slide shows anything.
        proxied = url;
        // The source follows from the play URL alone, so the slide can start on it: `/direct` was a
        // round trip and a resolve spent learning what `/hls` resolves for itself.
        ambient = hlsURL(url, playsHls) ?? url;
      });
    }, SETTLE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  });

  // MSE, where the browser will not play a playlist itself. hls.js takes the element rather than a
  // `src`, and is torn down with the source it was given, so a slide change cannot leave two engines
  // feeding one element.
  $effect(() => {
    const player = ambientPlayer;
    const master = managed;
    if (!player || !master) return;
    let live = true;
    let engine: Hls | undefined;
    void import('hls.js').then(({ default: Hls }) => {
      if (!live) return;
      if (!Hls.isSupported()) {
        ambientFailedOver();
        return;
      }
      // The membership claim travels on hls.js's own requests too, or a paired household counts as a
      // guest against the relay's guest budget — on its own box, from its own sofa.
      // Open near the top of the ladder instead of climbing to it, as the detail hero does: hls.js
      // assumes 500 kbps until it has measured a fragment, and `testBandwidth` makes it start lower
      // still to take that measurement. A slide is fifteen seconds, so the climb is the whole of it.
      engine = new Hls({
        enableWorker: false,
        xhrSetup: memberXhrSetup,
        abrEwmaDefaultEstimate: 5_000_000,
        testBandwidth: false,
      });
      engine.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) ambientFailedOver();
      });
      // Open on the rung carrying the most bits, found by MEASURE rather than by position.
      //
      // An index is not a ranking here. reel does sort its masters best-first, but hls.js orders `levels`
      // for itself, so naming level 0 asked for the WORST rung and opened every slide at 144p — measured,
      // as the itag in its own segment request. Handed back to ABR once a fragment is in, so a line that
      // cannot hold this still drops away from it.
      engine.on(Hls.Events.MANIFEST_PARSED, () => {
        const levels = engine?.levels ?? [];
        const best = levels.reduce(
          (top, level, at) => (level.bitrate > (levels[top]?.bitrate ?? 0) ? at : top),
          0,
        );
        if (engine && levels.length > 1) engine.nextLevel = best;
        // The element is mounted with no `src`, so nothing has tried to start it yet.
        if (active && onScreen && foreground) void player.play().catch(() => {});
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

  // Scrolled out of view, or left in a tab nobody is looking at: stop. Back in view: carry on from where it
  // stopped, which is what the still picture underneath has been standing in for.
  $effect(() => {
    const video = ambientPlayer;
    if (!video || !ambient) return;
    if (active && onScreen && foreground) {
      hush(video);
      void video.play().catch(() => {});
    } else {
      video.pause();
      // Pausing stops the picture. It does not stop a rendition AVFoundation has already started, which
      // is why a slide left behind on Home could still be heard from the page opened on top of it.
      hush(video);
    }
  });

  // --- The rail ---

  let rail = $state<HTMLDivElement>();
  /** While this stands, a scroll is the billboard's own doing and not the viewer's. */
  let driving = 0;

  /** Scroll to slide `n`. Instant where the viewer asked for less movement, or where the jump is the loop back. */
  function goTo(n: number, smooth = true) {
    const box = rail;
    if (!box) return;
    driving = Date.now();
    box.scrollTo({
      left: n === 0 ? 0 : n * box.clientWidth,
      behavior: smooth && !still() ? 'smooth' : 'auto',
    });
  }

  /**
   * Which slide is in front of the viewer, watched rather than worked out from scroll events. Those arrive on
   * the browser's own frame schedule and are coalesced — or, in a background tab, not sent at all — so during a
   * brisk swipe `index` fell a slide behind the rail. Everything hanging off it went with it: the dots, and the
   * picture, which is how one title's backdrop ended up behind another title's name.
   */
  $effect(() => {
    const box = rail;
    void shown.length;
    if (!box || typeof IntersectionObserver === 'undefined') return;
    const slides = Array.from(box.children) as HTMLElement[];
    const watch = new IntersectionObserver(
      (entries) => {
        if (!active || box.clientWidth === 0) return;
        const visible = Math.round(box.scrollLeft / box.clientWidth);
        for (const entry of entries) {
          const at = slides.indexOf(entry.target as HTMLElement);
          // Discard queued intersections from before a retained rail's scroll position was restored.
          if (entry.isIntersecting && at === visible && at >= 0 && at !== index) index = at;
        }
      },
      { root: box, threshold: 0.6 },
    );
    for (const slide of slides) watch.observe(slide);
    return () => watch.disconnect();
  });

  /**
   * Which slide the rail has come to rest on, and whether the viewer put it there.
   *
   * This is everything that runs while a finger is on the screen — a division and a comparison, and a write only
   * when the slide actually changes. Driving the parallax from here instead, a style property per slide per
   * frame, is what made the scroll stutter: a custom property cannot be composited, so every frame went back
   * through style and paint on the main thread. The drift belongs to CSS, below, where it costs nothing.
   */
  function scrolled() {
    const box = rail;
    if (!active || !box || box.clientWidth === 0) return;
    const at = Math.round(box.scrollLeft / box.clientWidth);
    if (at !== index && at >= 0 && at < shown.length) index = at;
    // A scroll of its own making is still rotation; a scroll of the viewer's ends it. Smooth scrolling keeps
    // firing for a while after it is asked for, so a moment's grace before the next one counts as theirs.
    if (Date.now() - driving > 1200) paging = true;
  }

  // A different set of titles is a different billboard: start it at the beginning rather than leaving the rail
  // parked where the last set had scrolled to, which would show slide seven of a list that just changed.
  let previousFirst = '';
  $effect(() => {
    const first = firstTitleKey;
    if (!first) return;
    untrack(() => {
      index = 0;
      // A new rail is already at zero. scrollTo itself forces layout if slides were just inserted.
      if (previousFirst) goTo(0, false);
      previousFirst = first;
    });
  });

  function show(n: number) {
    paging = true;
    goTo(n);
  }

  function keyed(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = index + (event.key === 'ArrowRight' ? 1 : -1);
    show(Math.min(Math.max(next, 0), shown.length - 1));
  }

  /**
   * The same paging from the page itself, with nothing focused. A carousel you are looking at is one the
   * arrow keys should move; before this they worked only once a dot had been tabbed to, which nobody does.
   *
   * Left alone when the keys are already spoken for: while typing, and when something else has already
   * handled the event — a focused dot runs `keyed` itself and this listener sees the key afterwards, so
   * without that check every press would page twice.
   */
  $effect(() => {
    if (!active || !onScreen) return;
    const fromPage = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable]')
      ) {
        return;
      }
      keyed(event);
    };
    window.addEventListener('keydown', fromPage);
    return () => window.removeEventListener('keydown', fromPage);
  });

  // It cycles on its own until you move it, and holds while you are reading it — pointer over it, or a control
  // in it focused. Nothing moves for a viewer who asked for less movement.
  $effect(() => {
    if (!active || !onScreen || paging || held || shown.length < 2 || still()) return;
    const timer = setInterval(() => {
      const next = (index + 1) % shown.length;
      // The wrap is a jump rather than a scroll back through forty slides.
      goTo(next, next !== 0);
    }, ADVANCE_MS);
    return () => clearInterval(timer);
  });

  /**
   * Full screen, with the sound on. The billboard's trailer is deliberately mute decoration — nothing here
   * can ask for audio — so this is the one gesture that says otherwise, and a gesture is the only thing a
   * browser will unmute for. It goes quiet again on the way out: a trailer still talking over a page the
   * viewer has returned to is the thing they would then have to hunt down and silence.
   */
  /** WebKit's handle on a master's separate audio rendition. Absent in every other browser. */
  type Renditions = { length: number; [at: number]: { enabled: boolean } };

  /**
   * Quiet, said in the way this browser needs.
   *
   * reel's masters carry a separate audio rendition (`EXT-X-MEDIA:TYPE=AUDIO`), and Safari hands such a
   * master to AVFoundation, which plays that rendition through a path `muted` never reaches — and keeps
   * playing it while the element itself reports paused. That is what put trailer sound behind a detail
   * page: this slide, stopped and muted, carried on talking, and no property readable on the detail
   * page's own video could show it. The rendition has to be switched off by name, and it does not exist
   * until metadata has been read.
   */
  function hush(player: HTMLMediaElement, loud = false) {
    player.muted = !loud;
    const tracks = (player as HTMLMediaElement & { audioTracks?: Renditions }).audioTracks;
    if (!tracks) return;
    for (let at = 0; at < tracks.length; at += 1) {
      const track = tracks[at];
      if (track) track.enabled = loud;
    }
  }

  async function expand() {
    const player = ambientPlayer;
    if (!player) return;
    hush(player, true);
    // iOS ignores this (volume is read-only there); unmuting is what carries the sound.
    player.volume = 1;
    const leave = () => {
      if (document.fullscreenElement) return;
      hush(player);
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
      // Refused or unsupported: `leave` never fires, so take the listener back off rather than leave one
      // behind for every press.
      document.removeEventListener('fullscreenchange', leave);
    }
    void player.play().catch(() => {});
  }

  const facts = (title: Title) => {
    const found = known.get(keyOf(title));
    return [title.year ? String(title.year) : undefined, ...(found?.genres ?? []).slice(0, 2)]
      .filter(Boolean)
      .join(' · ');
  };

  /** The dots in view: a window that slides with the current slide, its edges shrunk where the set carries on. */
  const window9 = $derived.by(() => {
    const count = shown.length;
    const start =
      count <= DOT_WINDOW
        ? 0
        : Math.min(Math.max(index - (DOT_WINDOW >> 1), 0), count - DOT_WINDOW);
    const end = Math.min(start + DOT_WINDOW, count);
    return { start, end, count, at: Array.from({ length: end - start }, (_, i) => start + i) };
  });
</script>

<!-- Drawn before there is anything to draw: the billboard's height is the same whether or not its titles have
     arrived, so the page doesn't jump when they do. -->
<section
  class="billboard"
  use:stableViewportHeight
  aria-roledescription="carousel"
  aria-label="Featured"
  bind:this={frame}
  onpointerenter={() => (held = true)}
  onpointerleave={() => (held = false)}
  onfocusin={() => (held = true)}
  onfocusout={() => (held = false)}
>
  <div class="picture" aria-hidden="true">
    {#each layers as layer (layer.id)}
      {#if layer.url}
        <img
          class="backdrop"
          class:lit={layer.id === lit}
          src={layer.url}
          fetchpriority={layer.id === lit ? 'high' : 'low'}
          alt=""
          draggable="false"
        />
      {/if}
    {/each}
    {#if ambient}
      <!-- den-reel's own MP4: no player chrome to hide, nothing to press, and it says for itself when it has
           started. The still picture stays underneath until it does, and stays if it never does. -->
      <video
        bind:this={ambientPlayer}
        class="ambient"
        class:playing
        src={managed ? undefined : (ambient ?? undefined)}
        autoplay
        muted
        loop
        playsinline
        preload="auto"
        tabindex="-1"
        onplaying={() => (playing = true)}
        onerror={ambientFailedOver}
        onloadstart={(event) => hush(event.currentTarget)}
        onloadedmetadata={(event) => hush(event.currentTarget)}
      ></video>
    {/if}
    <div class="scrim"></div>
    <div class="fade"></div>
  </div>

  <!-- Three ways to notice, because one is not reliable: the observer above settles it, `scroll` catches it
       early where the browser sends those, and `scrollend` fires once when a swipe finally comes to rest. -->
  <div class="rail" bind:this={rail} onscroll={scrolled} onscrollend={scrolled}>
    {#each shown as title, n (keyOf(title))}
      {@const found = known.get(keyOf(title))}
      <article
        class="slide"
        aria-roledescription="slide"
        aria-label={title.title}
        aria-hidden={n !== index}
        inert={n !== index}
      >
        <a
          class="slide-link"
          href={titleHref(title)}
          aria-label={`Open details for ${title.title}`}
          tabindex={n === index ? 0 : -1}
          draggable="false"
        ></a>
        <div class="told">
          <div class="text">
            <h2>
              <a class="title-link" href={titleHref(title)} tabindex={n === index ? 0 : -1}
                >{title.title}</a
              ><span class="mobile-title">{title.title}</span>
            </h2>
            <p class="facts">{facts(title)}</p>
            <p class="overview">{found?.overview ?? ''}</p>
            <div class="actions">
              {#if onplay}
                <button
                  class="primary"
                  tabindex={n === index ? 0 : -1}
                  onclick={() => onplay(title)}
                >
                  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M8.8 5.6 19 12 8.8 18.4V5.6Z" />
                  </svg>
                  Play
                </button>
              {/if}
              <a class="more" href={titleHref(title)} tabindex={n === index ? 0 : -1}>More</a>
            </div>
          </div>
        </div>
      </article>
    {/each}
  </div>

  <!-- Only once a trailer is actually running: a button offering full screen over a still photograph would
       have nothing to show. Desktop only, in CSS — a phone reaches the video's own controls with a tap. -->
  {#if playing}
    <button class="expand glass" onclick={expand} aria-label="Play trailer full screen with sound">
      <DetailIcon name="expand" />
    </button>
  {/if}

  <!-- Outside the rail: the pager is the one thing that shouldn't slide away with the slide it counts. -->
  {#if shown.length > 1}
    <div class="pager">
      <div class="dots" role="group" aria-label="Slide {index + 1} of {shown.length}">
        {#each window9.at as n (n)}
          {@const edge =
            (n === window9.start && window9.start > 0) ||
            (n === window9.end - 1 && window9.end < window9.count)}
          <button
            class="dot"
            class:on={n === index}
            class:edge
            aria-label={shown[n]?.title ?? `Slide ${n + 1}`}
            aria-current={n === index ? 'true' : undefined}
            onclick={() => show(n)}
            onkeydown={keyed}
          ></button>
        {/each}
      </div>
    </div>
  {/if}
</section>

<style>
  /* Full-bleed out of the page's column, and up behind the floating bar, as the TV's hero runs up behind the
     tab bar. The page's own background shows through the fade at the bottom, so there is no band where the
     billboard ends. */
  .billboard {
    position: relative;
    width: 100vw;

    /* Lets the picture, which is not inside the scroller, be animated by the scroller's own progress. */
    timeline-scope: --rail;

    /* Use the large viewport initially, then preserve the measured size through touch-browser
       toolbar changes. Width changes and desktop window resizing refresh the measurement. */
    min-height: var(--stable-hero-height, clamp(420px, 76vh, 860px));
    margin-inline: calc(50% - 50vw);
    margin-top: calc(-1 * var(--bar-space));
    margin-bottom: 28px;
    overflow: hidden;
    background: var(--bg);
  }

  @supports (height: 1lvh) {
    .billboard {
      min-height: var(--stable-hero-height, clamp(420px, 76lvh, 860px));
    }
  }

  /* On a wide screen a height capped in pixels turns the billboard into a letterbox slot — 3:1 and wider —
     while what it frames is 16:9. Past this width it therefore never falls below nine sixteenths of the
     width, bounded by the window so the rows beneath it still show.

     Gated by WIDTH on purpose. Below it the measured viewport height is the whole point — a phone's
     toolbar sliding away must not resize the hero — and a short landscape window (844x600, say) is wider
     than 16:9 without being a big screen, so an ungated floor would override the measurement there. */
  @media (width >= 1000px) {
    .billboard {
      min-height: max(var(--stable-hero-height, clamp(420px, 76vh, 860px)), min(56.25vw, 94vh));
    }

    @supports (height: 1lvh) {
      .billboard {
        min-height: max(var(--stable-hero-height, clamp(420px, 76lvh, 860px)), min(56.25vw, 94lvh));
      }
    }
  }

  /* Glass, because this is a control over media — the one place that look is for. */
  .expand {
    position: absolute;
    top: calc(var(--bar-space) + 12px);
    right: var(--gutter);
    z-index: 2;
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

  /* Before the hover rule, which is the more specific of the two: a control reached by keyboard has to show
     itself without waiting for a pointer that may never arrive. */
  .expand:focus-visible {
    opacity: 1;
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }

  .billboard:hover .expand {
    opacity: 1;
  }

  @media (prefers-reduced-motion: reduce) {
    .expand {
      transition: none;
    }
  }

  @media (width <= 759px) {
    .expand {
      display: none;
    }
  }

  /* One picture for the whole billboard, behind everything: it dissolves between titles instead of sliding, so
     no seam ever crosses the screen. It drifts by a fraction of the rail's travel (`--p`) to keep some depth,
     and is drawn wider than the frame so that drift never shows an edge. */
  .picture {
    position: absolute;
    inset: 0;
    transform: scale(1.14);

    /* Named, and the detail page's hero carries the same name: opening a title then morphs this
       picture into that one rather than cross-fading the whole page through the background. What the
       browser captures here is the trailer's last painted frame, and what it morphs into is a hero
       already showing the same backdrop, so the two ends of the movement match. Coming back needs
       none of this — Home is never unmounted and its trailer never stopped. */
    view-transition-name: den-hero-media;
    contain: layout;
  }

  /* The drift, handed to the compositor: tied to the rail's own scroll progress rather than recomputed in
     JavaScript each frame, so it costs the scroll nothing. Browsers without scroll-driven animations simply
     get a still picture, which is the same billboard with less depth. */
  @supports (animation-timeline: --rail) {
    @media not (prefers-reduced-motion: reduce) {
      .picture {
        animation: drift linear both;
        animation-timeline: --rail;
        will-change: transform;
      }
    }
  }

  @keyframes drift {
    from {
      transform: translate3d(2.5%, 0, 0) scale(1.14);
    }

    to {
      transform: translate3d(-2.5%, 0, 0) scale(1.14);
    }
  }

  .backdrop,
  .ambient {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity 0.55s ease;
    -webkit-user-drag: none;
  }

  .backdrop.lit,
  .ambient.playing {
    opacity: 1;
  }

  .ambient {
    pointer-events: none;
  }

  /* Enough dark at the top for the bar to stay legible over a bright frame. */
  .scrim {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      to bottom,
      rgb(0 0 0 / 0.55),
      rgb(0 0 0 / 0.15) 30%,
      transparent 55%
    );
    pointer-events: none;
  }

  /* An eased dissolve into the page colour, not a linear ramp: a straight alpha ramp reads as a banded
     diagonal. These stops sample smootherstep (6t⁵−15t⁴+10t³), as the TV's fade does. */
  .fade {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: 62%;
    background: linear-gradient(
      to bottom,
      rgb(11 11 15 / 0) 0%,
      rgb(11 11 15 / 0.013) 12.5%,
      rgb(11 11 15 / 0.104) 25%,
      rgb(11 11 15 / 0.259) 37.5%,
      rgb(11 11 15 / 0.5) 50%,
      rgb(11 11 15 / 0.742) 62.5%,
      rgb(11 11 15 / 0.897) 75%,
      rgb(11 11 15) 100%
    );
    pointer-events: none;
  }

  /* The scroller: only the words are in it, so it is transparent and sits over the picture. `mandatory` so it
     always comes to rest on a slide, and the scrollbar hidden because this is a billboard, not a document. */
  .rail {
    position: relative;
    display: flex;
    height: 100%;
    min-height: inherit;
    overflow: auto hidden;
    scroll-snap-type: x mandatory;

    /* A swipe that runs off the end shouldn't drag the page along behind it. */
    overscroll-behavior-x: contain;
    scrollbar-width: none;
    scroll-timeline: --rail x;
  }

  .rail::-webkit-scrollbar {
    display: none;
  }

  .slide {
    position: relative;
    display: grid;
    flex: 0 0 100%;
    align-items: end;
    min-height: inherit;
    scroll-snap-align: center;
    scroll-snap-stop: always;
  }

  .slide-link,
  .mobile-title {
    display: none;
  }

  /* The words sit in the page's own column, so they line up with the rows below rather than with the screen.
     The room at the bottom is the pager's, which sits over every slide rather than in one. */
  .told {
    width: 100%;
    max-width: 1400px;
    margin: 0 auto;
    padding: var(--bar-space) var(--gutter) 76px;
  }

  .text {
    display: grid;
    gap: 8px;
    max-width: 720px;
    min-height: 190px;
    align-content: end;
  }

  /* Shadow the rendered text after line clamping so overflow doesn't cut a hard edge through it.
     Keep it tight: the backdrop fade supplies the broader contrast. */
  h2,
  .facts,
  .overview {
    filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.8));
  }

  h2 {
    margin: 0;
    font-size: clamp(26px, 6vw, 48px);
    line-height: 1.05;

    /* A ceiling, not a reservation: the text sits at the bottom of the hero, so a one-line title simply leaves
       the room above it empty rather than a gap under it.

       Two lines at 1.05em is 2.1em of LINE BOXES, which is not 2.1em of letters: a descender hangs below its
       line box, so the g in "Our Friends & Neighbors" was sliced off by the overflow. The line clamp below is
       what holds this to two lines — this only has to be tall enough not to cut through them. */
    max-block-size: 2.4em;
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  h2 a {
    color: var(--fg);
    text-decoration: none;
  }

  /* Nearly white, not the app's secondary grey. That grey is chosen for the page's dark ground; over a
     photograph — a white wall, a bright sky — it disappears entirely, and a year and two genres are exactly
     the sort of small text that goes first. */
  .facts {
    margin: 0;
    color: rgb(255 255 255 / 0.92);
    font-size: 14px;
    line-height: 1.4;
    max-block-size: 2.8em;
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  /* Three lines: a billboard says what it is, the title's own page says the rest. */
  .overview {
    display: -webkit-box;
    margin: 0;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    color: rgb(255 255 255 / 0.88);
    font-size: 15px;
    line-height: 1.4;
    max-block-size: 4.2em;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 4px;
  }

  .primary,
  .more {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: center;
    min-height: 48px;
    padding: 0 20px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: none;
    color: var(--fg);
    font: inherit;
    text-decoration: none;
    cursor: pointer;
  }

  .primary {
    border-color: var(--accent);
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }

  .icon {
    flex: 0 0 auto;
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentcolor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Held over the rail, in the page's own column, so it stays put while the slides pass under it. */
  .pager {
    position: absolute;
    z-index: 2;
    right: 0;
    bottom: 32px;
    left: 0;
    display: flex;
    max-width: 1400px;
    margin: 0 auto;
    padding-inline: var(--gutter);
    pointer-events: none;
  }

  /* A finger's worth of button around a small mark, as the TV's dots are a row under the text. */
  .dots {
    display: flex;
    gap: 2px;
    pointer-events: auto;
  }

  .dot {
    display: grid;
    place-items: center;
    width: 24px;
    height: 32px;
    padding: 0;
    border: 0;
    background: none;
    cursor: pointer;
  }

  .dot::before {
    display: block;
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: rgb(255 255 255 / 0.35);
    content: '';
    transition:
      width 0.2s ease,
      height 0.2s ease,
      background-color 0.2s ease;
  }

  /* The bullet at either end of the window is drawn smaller where the set carries on past it — the pager says
     "there is more this way" without growing a fortieth bullet. */
  .dot.edge::before {
    width: 4px;
    height: 4px;
  }

  .dot.on::before {
    width: 9px;
    height: 9px;
    background: var(--fg);
  }

  .primary:focus-visible,
  .more:focus-visible,
  .dot:focus-visible,
  h2 a:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  @media (width <= 759px) {
    .slide-link {
      display: block;
      position: absolute;
      inset: 0;
      z-index: 1;
    }

    .slide-link:focus-visible {
      outline: 2px solid var(--fg);
      outline-offset: -4px;
    }

    .mobile-title {
      display: inline;
    }

    .title-link,
    .actions {
      display: none;
    }

    .text {
      min-height: 0;
    }
  }

  @media (width >= 360px) and (width <= 759px) {
    h2 {
      /* Room for the descenders, as above; the clamp is what keeps it to one line. */
      max-block-size: 1.3em;
      -webkit-line-clamp: 1;
      line-clamp: 1;
    }
  }
</style>
