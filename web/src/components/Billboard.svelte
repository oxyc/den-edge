<!-- Home's billboard: one title, large, above the rows — what you are part-way through, else the first thing on your
     watchlist, else what is trending. A still, as the TV's hero is until it has a trailer to play: motion here would
     cost a phone its data and its battery for decoration. -->
<script lang="ts">
  import { fetchDetail, type TitleDetail } from '../lib/detail';
  import type { Title } from '../lib/library';
  import { titleHref } from '../lib/route';

  let {
    title,
    tmdbKey,
    caption,
    onplay,
  }: {
    title: Title;
    tmdbKey: string;
    /** Where you are in it, when that's what put it here: `S2 · E4`. */
    caption?: string;
    /** Play it in this browser; no button without it. */
    onplay?: () => void;
  } = $props();

  let detail = $state<TitleDetail | null>(null);

  $effect(() => {
    const want = title;
    detail = null;
    if (!tmdbKey) return;
    void fetchDetail({ type: want.type, id: want.id }, tmdbKey).then((found) => {
      if (want === title) detail = found;
    });
  });

  const facts = $derived(
    [caption, title.year ? String(title.year) : undefined, ...(detail?.genres ?? []).slice(0, 2)]
      .filter(Boolean)
      .join(' · '),
  );
</script>

<section class="billboard">
  {#if detail?.backdropPath}
    <img class="backdrop" src="https://image.tmdb.org/t/p/w1280{detail.backdropPath}" alt="" />
  {/if}
  <div class="told">
    <h2><a href={titleHref(title)}>{title.title}</a></h2>
    {#if facts}<p class="facts">{facts}</p>{/if}
    {#if detail?.overview}<p class="overview">{detail.overview}</p>{/if}
    <div class="actions">
      {#if onplay}
        <button class="primary" onclick={onplay}>
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M8.8 5.6 19 12 8.8 18.4V5.6Z" />
          </svg>
          {caption ? 'Resume' : 'Play'}
        </button>
      {/if}
      <a class="more" href={titleHref(title)}>More</a>
    </div>
  </div>
</section>

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

  .primary:focus-visible,
  .more:focus-visible,
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
