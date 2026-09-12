<!-- Home's billboard, built as the TV's featured hero is: the leading row's titles, full-bleed and running up
     behind the bar, one at a time, cycling every fifteen seconds and looping both ways. It pages by swipe, by the
     arrow keys, or by its dots — and any of those stops the rotation, from then on it is yours to drive.

     The slide's trailer plays quietly behind it once it has settled, as the TV's hero does — muted, no chrome,
     nothing to press. It is decoration, so it gives way whenever it would cost more than it gives: Reduce
     Motion, Data Saver, or the billboard scrolled off the screen leave the still picture in its place. -->
<script lang="ts">
  import { cubicInOut } from 'svelte/easing';
  import { fade, fly } from 'svelte/transition';
  import { fetchDetail, type TitleDetail } from '../lib/detail';
  import type { Title } from '../lib/library';
  import { titleHref } from '../lib/route';

  let {
    titles,
    tmdbKey,
    onplay,
  }: {
    /** What the leading row holds; the first of them cycle here. */
    titles: Title[];
    tmdbKey: string;
    /** Play it in this browser; no button without it. */
    onplay?: (title: Title) => void;
  } = $props();

  /** As many as the TV's hero carries. The row behind it holds about a hundred, so this costs no extra request. */
  const SLIDES = 40;
  const ADVANCE_MS = 15_000;
  /** At most this many dots, sliding to keep the current one in view: forty bullets is a bar, not a pager. */
  const DOT_WINDOW = 9;
  /** How far a finger travels sideways before it counts as a page rather than a tap. */
  const SWIPE_PX = 28;
  /**
   * How much downward drift a sideways swipe may carry: the sideways travel must be at least this much of the
   * up-and-down travel. No finger draws a straight line, and asking for one turned real swipes into scrolls.
   */
  const SWIPE_BIAS = 0.7;

  const shown = $derived(titles.slice(0, SLIDES));
  let index = $state(0);
  /** Set once you page by hand, as on the TV: from then on the billboard holds still. */
  let paging = $state(false);
  let held = $state(false);
  const current = $derived(shown[Math.min(index, shown.length - 1)]);

  const keyOf = (title: Title) => `${title.type}:${title.id}`;
  const backdropURL = (path: string) => `https://image.tmdb.org/t/p/w1280${path}`;

  // Details arrive per slide and are kept: paging back to one already seen shows it at once rather than
  // fetching it again.
  const details = new Map<string, TitleDetail>();
  let detail = $state<TitleDetail | null>(null);

  async function detailOf(title: Title | undefined): Promise<TitleDetail | null> {
    if (!title || !tmdbKey) return null;
    const key = keyOf(title);
    const known = details.get(key);
    if (known) return known;
    const found = await fetchDetail({ type: title.type, id: title.id }, tmdbKey).catch(() => null);
    if (found) details.set(key, found);
    return found;
  }

  /** Fetch the slide's details, and warm the ones on either side so paging lands on a picture, not a wait. */
  $effect(() => {
    const want = current;
    detail = (want && details.get(keyOf(want))) ?? null;
    if (!want) return;
    void detailOf(want).then((found) => {
      if (want === current) detail = found;
    });
    if (shown.length < 2) return;
    for (const step of [1, -1]) {
      void detailOf(shown[(index + step + shown.length) % shown.length]).then((found) => {
        if (found?.backdropPath) new Image().src = backdropURL(found.backdropPath);
      });
    }
  });

  /** How long a slide stands still before its trailer starts: paging past five shouldn't start five videos. */
  const SETTLE_MS = 2000;
  /** The trailer playing behind the current slide, once it has earned it; null while the still picture stands. */
  let ambient = $state<string | null>(null);
  /** Held back until the embed has loaded and had a moment to start: an iframe paints its own black over the
      still long before there is a picture in it, and a trailer that never plays would leave the slide blank. */
  let playing = $state(false);
  let frame = $state<HTMLElement>();
  let onScreen = $state(true);
  /** Someone paying by the megabyte hasn't asked for a video they didn't press. */
  const saving = () => Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData);

  // A trailer playing under the rows, heard by nobody and seen by nobody, is battery and data spent on nothing.
  $effect(() => {
    const box = frame;
    if (!box || typeof IntersectionObserver === 'undefined') return;
    const watch = new IntersectionObserver(([entry]) => (onScreen = (entry?.intersectionRatio ?? 0) > 0.5), {
      threshold: [0, 0.5, 1],
    });
    watch.observe(box);
    return () => watch.disconnect();
  });

  $effect(() => {
    const key = detail?.trailer;
    ambient = null;
    playing = false;
    if (!key || !onScreen || still() || saving()) return;
    const timer = setTimeout(() => (ambient = key), SETTLE_MS);
    return () => clearTimeout(timer);
  });

  // It cycles on its own until you page it, and holds while you are reading it — pointer over it, or a control in
  // it focused. Nothing moves for a viewer who asked for less movement.
  $effect(() => {
    if (paging || held || shown.length < 2 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = setInterval(() => (index = (index + 1) % shown.length), ADVANCE_MS);
    return () => clearInterval(timer);
  });

  const facts = $derived(
    [current?.year ? String(current.year) : undefined, ...(detail?.genres ?? []).slice(0, 2)].filter(Boolean).join(' · '),
  );

  /** Which way a slide comes in from: the way you paged, as the TV pushes its text from the paging edge. */
  let direction = $state(1);
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** A slide's travel, in ms: nothing moves for a viewer who asked for less movement. */
  const slideMs = () => (still() ? 0 : 420);

  /** Page by `delta`, wrapping at either end: the set is a loop, as the TV's is. */
  function page(delta: number) {
    if (shown.length < 2) return;
    paging = true;
    direction = delta > 0 ? 1 : -1;
    index = (index + delta + shown.length) % shown.length;
  }

  function show(n: number) {
    paging = true;
    direction = n >= index ? 1 : -1;
    index = n;
  }

  /** The dots in view: a window that slides with the current slide, its edges shrunk where the set carries on. */
  const window9 = $derived.by(() => {
    const count = shown.length;
    const start = count <= DOT_WINDOW ? 0 : Math.min(Math.max(index - (DOT_WINDOW >> 1), 0), count - DOT_WINDOW);
    const end = Math.min(start + DOT_WINDOW, count);
    return { start, end, count, at: Array.from({ length: end - start }, (_, i) => start + i) };
  });

  // A swipe pages it, the way the remote's Left/Right does on the TV. A mouse is left alone — it has the dots,
  // and a drag there is usually a selection.
  let from: { x: number; y: number } | null = null;
  /** One page per gesture: the rest of the finger's travel is the same swipe, not the next one. */
  let swiped = false;

  function down(event: PointerEvent) {
    from = event.pointerType === 'mouse' ? null : { x: event.clientX, y: event.clientY };
    swiped = false;
  }

  /**
   * Turn the page the moment the swipe is unmistakable, rather than waiting for the finger to lift. The page
   * scrolls up and down under the same finger, so the browser decides which of the two a gesture is within its
   * first few pixels and takes the pointer away when it decides "scroll" — waiting for the lift lost every
   * swipe that sagged a little on its way across.
   */
  function moved(event: PointerEvent) {
    if (!from || swiped) return;
    const dx = event.clientX - from.x;
    const dy = event.clientY - from.y;
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * SWIPE_BIAS) return;
    swiped = true;
    page(dx < 0 ? 1 : -1);
  }

  /** A gesture that ended before a move said so — a flick over in one event — is judged the same way. */
  function up(event: PointerEvent) {
    if (from && !swiped) moved(event);
    from = null;
  }

  function keyed(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    page(event.key === 'ArrowRight' ? 1 : -1);
  }

  // The swipe is bound here rather than in the markup: a drag across a picture is a gesture, not a control, and
  // the things that ARE controls — the dots, the links, the buttons — carry the keyboard themselves.
  let stage = $state<HTMLDivElement>();
  $effect(() => {
    const box = stage;
    if (!box) return;
    // The browser cancels the pointer when it takes the gesture for a scroll; by then `moved` has already had
    // its say, so there is nothing to judge here — just forget the gesture.
    const cancel = () => (from = null);
    box.addEventListener('pointerdown', down);
    box.addEventListener('pointermove', moved, { passive: true });
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', cancel);
    return () => {
      box.removeEventListener('pointerdown', down);
      box.removeEventListener('pointermove', moved);
      box.removeEventListener('pointerup', up);
      box.removeEventListener('pointercancel', cancel);
    };
  });
</script>

<!-- Drawn before there is anything to draw: the billboard's height is the same whether or not its titles have
     arrived, so the page doesn't jump when they do. -->
<section
  class="billboard"
  aria-roledescription="carousel"
  aria-label="Featured"
  onpointerenter={() => (held = true)}
  onpointerleave={() => (held = false)}
  onfocusin={() => (held = true)}
  onfocusout={() => (held = false)}
>
  <!-- The surface a swipe is read from; its listeners are bound in the script, beside the gesture itself. -->
  <div class="stage" bind:this={stage}>
    <!-- Both pictures are in the same box, so one dissolves into the next instead of leaving a black frame. -->
    {#if detail?.backdropPath}
      {#key detail.backdropPath}
        <img
          class="backdrop"
          src={backdropURL(detail.backdropPath)}
          alt=""
          draggable="false"
          in:fade={{ duration: slideMs() }}
          out:fade={{ duration: slideMs() }}
        />
      {/key}
    {/if}
    {#if ambient}
      <!-- Muted, chrome-less and untouchable: the swipe belongs to the billboard, not to YouTube's player. The
           still picture stays underneath, so a trailer that refuses to be embedded costs the slide nothing. -->
      <div class="ambient" class:playing aria-hidden="true">
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(ambient)}?autoplay=1&mute=1&controls=0&loop=1&playlist=${encodeURIComponent(ambient)}&playsinline=1&modestbranding=1&rel=0&disablekb=1&fs=0&iv_load_policy=3&start=10`}
          title="Trailer"
          tabindex="-1"
          allow="autoplay; encrypted-media"
          referrerpolicy="strict-origin-when-cross-origin"
          onload={() => setTimeout(() => (playing = true), 900)}
        ></iframe>
      </div>
    {/if}
    <div class="scrim"></div>
    <div class="fade"></div>
    <div class="told">
      <!-- The words are pushed in from the edge you paged towards, as the TV's hero pushes them; the dots below
           stay where they are, since they are the indicator and not part of the slide. -->
      <div class="stack">
        {#if current}
          {#key `${current.type}:${current.id}`}
            {@const title = current}
            <div
              class="text"
              in:fly={{ x: 48 * direction, duration: slideMs(), easing: cubicInOut }}
              out:fly={{ x: -48 * direction, duration: slideMs(), easing: cubicInOut }}
            >
              <h2><a href={titleHref(title)}>{title.title}</a></h2>
              {#if facts}<p class="facts">{facts}</p>{/if}
              {#if detail?.overview}<p class="overview">{detail.overview}</p>{/if}
              <div class="actions">
                {#if onplay}
                  <button class="primary" onclick={() => onplay(title)}>
                    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path d="M8.8 5.6 19 12 8.8 18.4V5.6Z" />
                    </svg>
                    Play
                  </button>
                {/if}
                <a class="more" href={titleHref(title)}>More</a>
              </div>
            </div>
          {/key}
        {/if}
      </div>
      {#if shown.length > 1}
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
      {/if}
    </div>
  </div>
</section>

<style>
  /* Full-bleed out of the page's column, and up behind the floating bar, as the TV's hero runs up behind the
     tab bar. The page's own background shows through the fade at the bottom, so there is no band where the
     billboard ends. */
  .billboard {
    position: relative;
    display: grid;
    align-items: end;
    width: 100vw;
    /* The large viewport, not the dynamic one: `vh` grows as a phone's address bar rolls away, which would
       resize the hero mid-scroll and drag the whole page with it. `lvh` is the height with the bar gone, so the
       billboard is the same size before and after. The `vh` line is what a browser without `lvh` reads. */
    min-height: clamp(420px, 76vh, 860px);
    min-height: clamp(420px, 76lvh, 860px);
    margin-inline: calc(50% - 50vw);
    margin-top: calc(-1 * var(--bar-space));
    margin-bottom: 28px;
    overflow: hidden;
    background: var(--bg);
    /* Sideways is the billboard's; up and down stays the page's. */
    touch-action: pan-y;
    user-select: none;
    -webkit-user-select: none;
  }

  /* No box of its own: the picture, the scrim and the words stay the billboard's own children, and this only
     catches the gestures over them. */
  .stage {
    display: contents;
  }

  .backdrop {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    -webkit-user-drag: none;
  }

  /* Sized to cover the hero rather than fit it: a 16:9 video fills a taller box and is cropped, the way the
     backdrop is, so there are never bars around it. It fades up over the still it replaces. */
  .ambient {
    position: absolute;
    inset: 0;
    overflow: hidden;
    opacity: 0;
    transition: opacity 0.8s ease;
    pointer-events: none;
  }

  .ambient.playing {
    opacity: 1;
  }

  .ambient iframe {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 177.78lvh;
    min-width: 100vw;
    height: 100lvh;
    min-height: 56.25vw;
    border: 0;
    transform: translate(-50%, -50%);
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
      rgb(11 11 15 / 0.987) 87.5%,
      rgb(11 11 15) 100%
    );
    pointer-events: none;
  }

  /* The words sit in the page's own column, so they line up with the rows below rather than with the screen. */
  .told {
    position: relative;
    width: 100%;
    max-width: 1400px;
    margin: 0 auto;
    padding: var(--bar-space) var(--gutter) 32px;
  }

  /* One cell, so the slide leaving and the slide arriving sit on top of each other rather than stacking up and
     pushing the dots down as they pass. */
  .stack {
    display: grid;
    min-height: 190px;
    align-items: end;
  }

  .text {
    display: grid;
    grid-area: 1 / 1;
    gap: 8px;
    max-width: 720px;
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

  /* A finger's worth of button around a small mark, as the TV's dots are a row under the text. */
  .dots {
    display: flex;
    gap: 2px;
    margin-top: 4px;
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
