<!-- Home's billboard, built as the TV's featured hero is: the leading row's titles, full-bleed and running up
     behind the bar, one at a time, cycling every fifteen seconds and looping both ways. It pages by swipe, by the
     arrow keys, or by its dots — and any of those stops the rotation, from then on it is yours to drive. A still
     picture, not a trailer: motion here would cost a phone its data and its battery for decoration. -->
<script lang="ts">
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
  /** How far a finger travels before it counts as a page rather than a tap. */
  const SWIPE_PX = 40;

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

  /** Page by `delta`, wrapping at either end: the set is a loop, as the TV's is. */
  function page(delta: number) {
    if (shown.length < 2) return;
    paging = true;
    index = (index + delta + shown.length) % shown.length;
  }

  function show(n: number) {
    paging = true;
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
  function down(event: PointerEvent) {
    from = event.pointerType === 'mouse' ? null : { x: event.clientX, y: event.clientY };
  }
  function up(event: PointerEvent) {
    const start = from;
    from = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    // Sideways only: a diagonal drag down the page is a scroll, and paging on it would fight the scroll.
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(event.clientY - start.y)) page(dx < 0 ? 1 : -1);
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
    const cancel = () => (from = null);
    box.addEventListener('pointerdown', down);
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', cancel);
    return () => {
      box.removeEventListener('pointerdown', down);
      box.removeEventListener('pointerup', up);
      box.removeEventListener('pointercancel', cancel);
    };
  });
</script>

{#if current}
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
      {#if detail?.backdropPath}
        <img class="backdrop" src={backdropURL(detail.backdropPath)} alt="" draggable="false" />
      {/if}
      <div class="scrim"></div>
      <div class="fade"></div>
      <div class="told">
        <div class="text">
          <h2><a href={titleHref(current)}>{current.title}</a></h2>
          {#if facts}<p class="facts">{facts}</p>{/if}
          {#if detail?.overview}<p class="overview">{detail.overview}</p>{/if}
          <div class="actions">
            {#if onplay}
              {@const title = current}
              <button class="primary" onclick={() => onplay(title)}>
                <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M8.8 5.6 19 12 8.8 18.4V5.6Z" />
                </svg>
                Play
              </button>
            {/if}
            <a class="more" href={titleHref(current)}>More</a>
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
    </div>
  </section>
{/if}

<style>
  /* Full-bleed out of the page's column, and up behind the floating bar, as the TV's hero runs up behind the
     tab bar. The page's own background shows through the fade at the bottom, so there is no band where the
     billboard ends. */
  .billboard {
    position: relative;
    display: grid;
    align-items: end;
    width: 100vw;
    min-height: clamp(420px, 76vh, 860px);
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

  .text {
    display: grid;
    gap: 8px;
    max-width: 720px;
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
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: rgb(255 255 255 / 0.35);
    content: '';
  }

  /* Shrunk to say the set carries on past the window. */
  .dot.edge::before {
    width: 5px;
    height: 5px;
  }

  .dot.on::before {
    width: 8px;
    height: 8px;
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
