<!-- Home's billboard, as the TV's featured hero works: the leading row's titles, one at a time, cycling every 15
     seconds with dots to page by hand. A still picture, not a trailer — motion here would cost a phone its data and
     its battery for decoration, and YouTube's embed can't be told to play quietly without its own chrome. -->
<script lang="ts">
  import { fetchDetail, type TitleDetail } from '../lib/detail';
  import type { Title } from '../lib/library';
  import { titleHref } from '../lib/route';

  let {
    titles,
    tmdbKey,
    onplay,
  }: {
    /** What the leading row holds; the first few of them cycle here. */
    titles: Title[];
    tmdbKey: string;
    /** Play it in this browser; no button without it. */
    onplay?: (title: Title) => void;
  } = $props();

  /** How many of the row's titles cycle. The TV carries forty; a phone on mobile data fetches one backdrop each. */
  const SLIDES = 8;
  const ADVANCE_MS = 15_000;

  const shown = $derived(titles.slice(0, SLIDES));
  let index = $state(0);
  /** Set once you page by hand, as on the TV: from then on the billboard holds still. */
  let paging = $state(false);
  let held = $state(false);
  const current = $derived(shown[Math.min(index, shown.length - 1)]);

  let detail = $state<TitleDetail | null>(null);
  $effect(() => {
    const want = current;
    detail = null;
    if (!want || !tmdbKey) return;
    void fetchDetail({ type: want.type, id: want.id }, tmdbKey).then((found) => {
      if (want === current) detail = found;
    });
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

  function show(n: number) {
    paging = true;
    index = n;
  }
</script>

{#if current}
  <section
    class="billboard"
    aria-label="Featured"
    onpointerenter={() => (held = true)}
    onpointerleave={() => (held = false)}
    onfocusin={() => (held = true)}
    onfocusout={() => (held = false)}
  >
    {#if detail?.backdropPath}
      <img class="backdrop" src="https://image.tmdb.org/t/p/w1280{detail.backdropPath}" alt="" />
    {/if}
    <div class="told">
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
        <div class="dots">
          {#each shown as title, n (`${title.type}:${title.id}`)}
            <button
              class="dot"
              class:on={n === index}
              aria-label={title.title}
              aria-current={n === index ? 'true' : undefined}
              onclick={() => show(n)}
            ></button>
          {/each}
        </div>
      {/if}
    </div>
  </section>
{/if}

<style>
  .billboard {
    position: relative;
    display: grid;
    align-items: end;
    min-height: 260px;
    margin-bottom: 28px;
    overflow: hidden;
    border-radius: var(--radius);
    background: var(--card);
  }

  .backdrop {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* The words sit on the picture, so the picture gives way underneath them. */
  .told {
    position: relative;
    display: grid;
    gap: 8px;
    padding: 96px 20px 20px;
    background: linear-gradient(to top, rgb(11 11 15 / 0.92) 30%, rgb(11 11 15 / 0.55) 65%, transparent);
  }

  h2 {
    margin: 0;
    font-size: clamp(22px, 5vw, 34px);
    line-height: 1.1;
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

  /* Two lines on a phone: a billboard says what it is, the title's own page says the rest. */
  .overview {
    display: -webkit-box;
    max-width: 64ch;
    margin: 0;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
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
    min-height: 44px;
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

  .dot.on::before {
    background: var(--fg);
  }

  .primary:focus-visible,
  .more:focus-visible,
  .dot:focus-visible,
  h2 a:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  @media (min-width: 760px) {
    .billboard {
      min-height: 360px;
      max-height: 60vh;
    }

    .told {
      padding: 140px 32px 32px;
      background: linear-gradient(to top, rgb(11 11 15 / 0.92) 20%, rgb(11 11 15 / 0.4) 60%, transparent);
    }
  }
</style>
