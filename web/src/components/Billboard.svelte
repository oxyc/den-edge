<!-- Home's billboard: full-bleed, running up behind the bar, cycling every fifteen seconds.

     It is a scroller, not a stack of cross-fades. The slides sit in a row and the browser snaps between them,
     so a swipe follows the finger with its own momentum and rubber-banding, a trackpad works, and the whole
     hand-rolled business of measuring a drag and guessing whether it meant "page" or "scroll the page" is gone
     — that guessing is what turned a swipe that sagged a little into a scroll.

     The slide's trailer plays quietly behind it once it has settled, as the TV's hero does — muted, no chrome,
     nothing to press. It is decoration, so it gives way whenever it would cost more than it gives: Reduce
     Motion, Data Saver, or the billboard scrolled off the screen leave the still picture in its place. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import { fetchDetail, type TitleDetail } from '../lib/detail';
  import type { Title } from '../lib/library';
  import { trailerURL } from '../lib/reel';
  import { titleHref } from '../lib/route';
  import type { Routes } from '../lib/routes';

  let {
    titles,
    tmdbKey,
    onplay,
    reel,
    routes,
  }: {
    /** The billboard's titles, best first. */
    titles: Title[];
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
  /** How long a slide stands still before its trailer starts: paging past five shouldn't start five videos. */
  const SETTLE_MS = 2000;

  const shown = $derived(titles.slice(0, SLIDES));
  let index = $state(0);
  /** Set once you move it by hand: from then on it holds still and is yours to drive. */
  let paging = $state(false);
  let held = $state(false);
  const current = $derived(shown[Math.min(index, shown.length - 1)]);

  const keyOf = (title: Title) => `${title.type}:${title.id}`;
  const backdropURL = (path: string) => `https://image.tmdb.org/t/p/w1280${path}`;
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Details arrive per slide and are kept, so coming back to one shows it at once. Held as state because the
  // slides read it while it fills in.
  let known = $state(new Map<string, TitleDetail>());

  async function learn(title: Title | undefined): Promise<void> {
    if (!title || !tmdbKey || known.has(keyOf(title))) return;
    const found = await fetchDetail({ type: title.type, id: title.id }, tmdbKey).catch(() => null);
    if (found) known = new Map(known).set(keyOf(title), found);
  }

  /** The slide and its neighbours: what is on screen now, and what a swipe would bring next. */
  const near = (n: number) => Math.abs(n - index) <= 1;
  const detail = $derived(current ? known.get(keyOf(current)) : undefined);

  $effect(() => {
    for (const step of [0, 1, -1]) void learn(shown[index + step]);
  });

  // A different set of titles is a different billboard: start it at the beginning rather than leaving the rail
  // parked where the last set had scrolled to, which would show slide seven of a list that just changed.
  $effect(() => {
    const first = shown[0] && keyOf(shown[0]);
    if (!first) return;
    untrack(() => {
      index = 0;
      goTo(0, false);
    });
  });

  /** The trailer playing behind the current slide, once it has earned it; null while the still picture stands. */
  let ambient = $state<string | null>(null);
  /** Held back until the video says it is running: a slide should never go blank waiting for one. */
  let playing = $state(false);
  let frame = $state<HTMLElement>();
  let onScreen = $state(true);
  /** Someone paying by the megabyte hasn't asked for a video they didn't press. */
  const saving = () => Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData);

  // A trailer playing under the rows, heard by nobody and seen by nobody, is battery and data spent on nothing.
  $effect(() => {
    const box = frame;
    if (!box || typeof IntersectionObserver === 'undefined') return;
    const watch = new IntersectionObserver(([entry]) => (onScreen = entry?.isIntersecting ?? true), { threshold: 0 });
    watch.observe(box);
    return () => watch.disconnect();
  });

  $effect(() => {
    const title = current;
    const imdbId = detail?.imdbId;
    const base = reel;
    const table = routes;
    ambient = null;
    playing = false;
    if (!title || !imdbId || !base || !onScreen || still() || saving()) return;
    let live = true;
    const timer = setTimeout(() => {
      void trailerURL(base, title.type, imdbId, table ?? {}).then((url) => {
        if (live && url) ambient = url;
      });
    }, SETTLE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
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
    box.scrollTo({ left: n * box.clientWidth, behavior: smooth && !still() ? 'smooth' : 'auto' });
  }

  /** Which slide the rail has come to rest on, and whether the viewer put it there. */
  function scrolled() {
    const box = rail;
    if (!box || box.clientWidth === 0) return;
    const at = Math.round(box.scrollLeft / box.clientWidth);
    if (at !== index && at >= 0 && at < shown.length) index = at;
    // A scroll of its own making is still rotation; a scroll of the viewer's ends it. Smooth scrolling keeps
    // firing for a while after it is asked for, so a moment's grace before the next one counts as theirs.
    if (Date.now() - driving > 1200) paging = true;
  }

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

  // It cycles on its own until you move it, and holds while you are reading it — pointer over it, or a control
  // in it focused. Nothing moves for a viewer who asked for less movement.
  $effect(() => {
    if (paging || held || shown.length < 2 || still()) return;
    const timer = setInterval(() => {
      const next = (index + 1) % shown.length;
      // The wrap is a jump rather than a scroll back through forty slides.
      goTo(next, next !== 0);
    }, ADVANCE_MS);
    return () => clearInterval(timer);
  });

  const facts = (title: Title) => {
    const found = known.get(keyOf(title));
    return [title.year ? String(title.year) : undefined, ...(found?.genres ?? []).slice(0, 2)].filter(Boolean).join(' · ');
  };

  /** The dots in view: a window that slides with the current slide, its edges shrunk where the set carries on. */
  const window9 = $derived.by(() => {
    const count = shown.length;
    const start = count <= DOT_WINDOW ? 0 : Math.min(Math.max(index - (DOT_WINDOW >> 1), 0), count - DOT_WINDOW);
    const end = Math.min(start + DOT_WINDOW, count);
    return { start, end, count, at: Array.from({ length: end - start }, (_, i) => start + i) };
  });
</script>

<!-- Drawn before there is anything to draw: the billboard's height is the same whether or not its titles have
     arrived, so the page doesn't jump when they do. -->
<section
  class="billboard"
  aria-roledescription="carousel"
  aria-label="Featured"
  bind:this={frame}
  onpointerenter={() => (held = true)}
  onpointerleave={() => (held = false)}
  onfocusin={() => (held = true)}
  onfocusout={() => (held = false)}
>
  <div class="rail" bind:this={rail} onscroll={scrolled}>
    {#each shown as title, n (keyOf(title))}
      {@const found = known.get(keyOf(title))}
      <article class="slide" aria-roledescription="slide" aria-label={title.title}>
        <!-- Only the slide in view and the ones a swipe away carry a picture; forty backdrops at once is a
             phone's whole data allowance for a page nobody has scrolled yet. -->
        {#if found?.backdropPath && near(n)}
          <img class="backdrop" src={backdropURL(found.backdropPath)} alt="" draggable="false" />
        {/if}
        {#if ambient && n === index}
          <!-- den-reel's own MP4: no player chrome to hide, nothing to press, and it says for itself when it
               has started. The still picture stays underneath until it does, and stays if it never does. -->
          <!-- svelte-ignore a11y_media_has_caption -->
          <video
            class="ambient"
            class:playing
            src={ambient}
            autoplay
            muted
            loop
            playsinline
            preload="auto"
            tabindex="-1"
            aria-hidden="true"
            onplaying={() => (playing = true)}
            onloadstart={(event) => (event.currentTarget.muted = true)}
          ></video>
        {/if}
        <div class="scrim"></div>
        <div class="fade"></div>
        <div class="told">
          <div class="text">
            <h2><a href={titleHref(title)} tabindex={n === index ? 0 : -1}>{title.title}</a></h2>
            {#if facts(title)}<p class="facts">{facts(title)}</p>{/if}
            {#if found?.overview}<p class="overview">{found.overview}</p>{/if}
            <div class="actions">
              {#if onplay}
                <button class="primary" tabindex={n === index ? 0 : -1} onclick={() => onplay(title)}>
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
  <!-- Outside the rail: the pager is the one thing that shouldn't slide away with the slide it counts. -->
  {#if shown.length > 1}
    <div class="pager">
      <div class="dots" role="group" aria-label="Slide {index + 1} of {shown.length}">
        {#each window9.at as n (n)}
          {@const edge =
            (n === window9.start && window9.start > 0) || (n === window9.end - 1 && window9.end < window9.count)}
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
    /* The large viewport, not the dynamic one: `vh` grows as a phone's address bar rolls away, which would
       resize the hero mid-scroll and drag the whole page with it. `lvh` is the height with the bar gone, so the
       billboard is the same size before and after. The `vh` line is what a browser without `lvh` reads. */
    min-height: clamp(420px, 76vh, 860px);
    min-height: clamp(420px, 76lvh, 860px);
    margin-inline: calc(50% - 50vw);
    margin-top: calc(-1 * var(--bar-space));
    margin-bottom: 28px;
    background: var(--bg);
  }

  /* The scroller itself. `mandatory` so it always comes to rest on a slide, and the scrollbar hidden because
     this is a billboard, not a document. */
  .rail {
    display: flex;
    height: 100%;
    min-height: inherit;
    overflow-x: auto;
    overflow-y: hidden;
    scroll-snap-type: x mandatory;
    /* A swipe that runs off the end shouldn't drag the page along behind it. */
    overscroll-behavior-x: contain;
    scrollbar-width: none;
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

  .backdrop {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    -webkit-user-drag: none;
  }

  /* Cropped to cover, the way the backdrop is, so there are never bars around it. It fades up over the still. */
  .ambient {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity 0.8s ease;
    pointer-events: none;
  }

  .ambient.playing {
    opacity: 1;
  }

  /* Enough dark at the top for the bar to stay legible over a bright frame. */
  .scrim {
    position: absolute;
    inset: 0;
    background: linear-gradient(to bottom, rgb(0 0 0 / 0.55), rgb(0 0 0 / 0.15) 30%, transparent 55%);
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

  /* The words sit in the page's own column, so they line up with the rows below rather than with the screen.
     The room at the bottom is the pager's, which sits over every slide rather than in one. */
  .told {
    position: relative;
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

  h2 {
    margin: 0;
    font-size: clamp(26px, 6vw, 48px);
    line-height: 1.05;
  }

  h2 a {
    color: var(--fg);
    text-decoration: none;
  }

  .facts {
    margin: 0;
    color: var(--muted);
    font-size: 14px;
  }

  /* Three lines: a billboard says what it is, the title's own page says the rest. */
  .overview {
    display: -webkit-box;
    margin: 0;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    color: rgb(231 231 234 / 0.8);
    font-size: 15px;
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
    transition: width 0.2s ease, height 0.2s ease, background-color 0.2s ease;
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
</style>
