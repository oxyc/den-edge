<script module lang="ts">
  const STILL_SIZES = '(max-width: 759px) clamp(96px, 29vw, 180px), clamp(190px, 24vw, 280px)';
  const stillSrcset = (path: string) =>
    [
      `https://image.tmdb.org/t/p/w300${path} 300w`,
      `https://image.tmdb.org/t/p/w500${path} 500w`,
    ].join(', ');
</script>

<script lang="ts">
  import DetailIcon from './DetailIcon.svelte';
  import ActionMenu from './ActionMenu.svelte';
  import { RESUME_FLOOR, WATCHED } from '../lib/actions';
  import { airDate, cleanedOverview, futureDate } from '../lib/detailPresentation';
  import type { MenuItem } from '../lib/titleActions';
  import type { Episode } from '../lib/detail';
  let {
    episode,
    progress,
    busy,
    deferred = false,
    fallback,
    onplay,
    onplaytv,
    onseen,
    onsources,
    ondownload,
    downloadState,
  }: {
    episode: Episode;
    progress: number;
    busy: boolean;
    /** A lightweight, inert card with the same content-dependent geometry; replaced in a later task. */
    deferred?: boolean;
    fallback?: string;
    onplay: () => void;
    /**
     * Send this episode to the linked TV. Absent for a guest, who has no TV to send to — and distinct from
     * `onplay`, which starts it here when this browser can play and only falls back to the TV when it can't.
     */
    onplaytv?: () => void;
    onseen: (seen: boolean) => void;
    onsources?: () => void;
    ondownload?: () => void;
    downloadState?: 'downloading' | 'ready';
  } = $props();
  const seen = $derived(progress >= WATCHED);
  const upcoming = $derived(futureDate(episode.airDate));
  const date = $derived(airDate(episode.airDate));
  const menuItems = $derived<MenuItem[]>([
    ...(onplaytv && !upcoming
      ? [{ kind: 'item' as const, label: 'Play on TV', onselect: onplaytv }]
      : []),
    ...(onsources && !upcoming
      ? [{ kind: 'item' as const, label: 'Sources', onselect: onsources }]
      : []),
    ...(ondownload && !upcoming
      ? [
          {
            kind: 'item' as const,
            label:
              downloadState === 'ready'
                ? 'Downloaded'
                : downloadState === 'downloading'
                  ? 'Downloading'
                  : 'Download',
            disabled: downloadState !== undefined,
            onselect: ondownload,
          },
        ]
      : []),
    {
      kind: 'item',
      label: seen ? 'Mark unwatched' : 'Mark watched',
      disabled: busy,
      onselect: () => onseen(!seen),
    },
  ]);
</script>

{#snippet about(interactive: boolean)}
  <span class="about">
    <span class="episode-heading"
      ><strong>{episode.name}</strong><span class="facts"
        >{[episode.runtime ? `${episode.runtime} min` : '', !upcoming ? date : '']
          .filter(Boolean)
          .join(' · ')}</span
      ></span
    >
    {#if downloadState}<span class="download-state">
        {#if interactive}<DetailIcon name="download" />{/if}{downloadState === 'ready'
          ? 'Downloaded'
          : 'Downloading'}
      </span>{/if}
    {#if upcoming}<span class="air-date">Airs <time datetime={episode.airDate}>{date}</time></span>
    {:else if episode.overview}<span class="overview">{cleanedOverview(episode)}</span>{/if}
  </span>
{/snippet}

<li class="episode" class:seen class:upcoming class:deferred aria-hidden={deferred || undefined}>
  {#if deferred}
    <span class="episode-play">
      <span class="still"></span>
      {@render about(false)}
    </span>
    <span class="episode-menu"></span>
  {:else}
    <button
      type="button"
      class="episode-play"
      disabled={upcoming || busy}
      onclick={onplay}
      aria-label={upcoming
        ? `Episode ${episode.number}: ${episode.name}. Airs ${date}`
        : `Play episode ${episode.number}: ${episode.name}`}
    >
      <span class="still">
        {#if episode.stillPath || fallback}
          {@const path = episode.stillPath ?? fallback!}
          <img
            src={`https://image.tmdb.org/t/p/w500${path}`}
            srcset={stillSrcset(path)}
            sizes={STILL_SIZES}
            alt=""
            width="500"
            height="281"
            loading="lazy"
            decoding="async"
          />
        {:else}<span class="missing-art"><DetailIcon name="play" /></span>{/if}
        <span class="number">{episode.number}</span>
        {#if seen}<span class="watched"><DetailIcon name="check" /></span>{/if}
        {#if !upcoming}<span class="play-glyph"><DetailIcon name="play" filled /></span>{/if}
        {#if progress > RESUME_FLOOR}<span
            class="progress"
            style:--progress={`${seen ? 100 : progress * 100}%`}
          ></span>{/if}
      </span>
      {@render about(true)}
    </button>
    <div class="episode-menu">
      <ActionMenu
        items={menuItems}
        label={`Options for episode ${episode.number}`}
        triggerClass="episode-trigger"
        glyph={more}
      />
    </div>
  {/if}
</li>

{#snippet more()}
  <DetailIcon name="more" />
{/snippet}

<style>
  .episode {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 44px;
    gap: 8px;
    align-items: center;
    padding: 12px;
    border-radius: 16px;

    /* Each row lays itself out from its own fixed grid. Keep its style/layout invalidation local without paint
       containment: keyboard outlines and the menu are deliberately allowed to escape the row. */
    contain: layout style;
  }

  .episode:has(.episode-play:hover),
  .episode:has(.episode-play:focus-visible) {
    background: rgb(255 255 255 / 0.06);
  }

  .episode.deferred {
    visibility: hidden;
    pointer-events: none;
  }

  .episode-play {
    display: grid;
    grid-template-columns: clamp(190px, 24vw, 280px) minmax(0, 1fr);
    gap: 36px;
    align-items: start;
    width: 100%;
    border: 0;
    padding: 0;
    background: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
    border-radius: 10px;
  }

  .episode-play:disabled {
    cursor: default;
  }

  .episode-play:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 6px;
  }

  .still {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: 16/9;
    overflow: hidden;
    border-radius: 10px;
    background: var(--card);
  }

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .seen img {
    opacity: 0.65;
  }

  .number {
    position: absolute;
    top: 8px;
    left: 8px;
    min-width: 24px;
    padding: 2px 7px;
    border-radius: 6px;
    background: #000b;
    text-align: center;
    font-size: 13px;
    font-weight: 600;
  }

  .progress {
    position: absolute;
    bottom: 8px;
    left: 8px;
    right: 8px;
    height: 4px;
    border-radius: 4px;
    background: #fff4;
  }

  .progress::after {
    content: '';
    display: block;
    width: var(--progress);
    height: 100%;
    border-radius: inherit;
    background: white;
  }

  .watched {
    position: absolute;
    right: 8px;
    top: 8px;
    color: white;
    filter: drop-shadow(0 1px 2px black);
  }

  .play-glyph,
  .missing-art {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
  }

  .play-glyph {
    opacity: 0;
    background: #0003;
  }

  .episode-play:hover .play-glyph,
  .episode-play:focus-visible .play-glyph {
    opacity: 1;
  }

  .episode-heading {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 6px 16px;
    align-items: baseline;
  }

  strong {
    font-size: 20px;
    line-height: 1.3;
  }

  .facts {
    color: var(--muted);
    font-size: 14px;
  }

  .download-state {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-top: 7px;
    color: var(--muted);
    font-size: 13px;
  }

  .download-state :global(svg) {
    width: 15px;
    height: 15px;
  }

  .overview {
    display: -webkit-box;
    margin-top: 10px;
    color: var(--muted);
    line-height: 1.5;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }

  .air-date {
    display: block;
    margin-top: 10px;
    color: #ffb55c;
  }

  .episode-menu {
    position: relative;
    align-self: center;
  }

  /* The trigger renders inside `ActionMenu`, a child component — reached the same way `Detail` reaches
     `DetailMedia`'s `.expand`, since a plain class name is scoped to its own component and `:global` isn't. */
  :global(.episode-trigger) {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    color: var(--muted);
  }

  :global(.episode-trigger:hover),
  :global(.episode-trigger[aria-expanded='true']) {
    background: #fff2;
    color: var(--fg);
  }

  :global(.episode-trigger:focus-visible) {
    outline: 2px solid var(--accent);
  }

  @media (width <= 759px) {
    .episode {
      padding: 8px 0;
      gap: 4px;
      border-radius: 10px;
    }

    .episode-play {
      grid-template-columns: clamp(96px, 29vw, 180px) minmax(0, 1fr);
      gap: 12px;
    }

    strong {
      font-size: 16px;
    }

    .facts {
      font-size: 12px;
    }

    .overview {
      margin-top: 5px;
      font-size: 13px;
      -webkit-line-clamp: 2;
      line-clamp: 2;
    }

    .air-date {
      margin-top: 6px;
      font-size: 13px;
    }

    .number {
      top: 4px;
      left: 4px;
      font-size: 11px;
      padding: 1px 5px;
      min-width: 20px;
    }

    .episode-menu {
      align-self: start;
    }

    .progress {
      bottom: 5px;
      left: 5px;
      right: 5px;
      height: 3px;
    }
  }
</style>
