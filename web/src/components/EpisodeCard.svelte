<script module lang="ts">
  const STILL_SIZES = __DEN_TV__
    ? 'clamp(320px, 18vw, 360px)'
    : '(max-width: 759px) clamp(96px, 29vw, 180px), clamp(190px, 24vw, 280px)';
  const stillSrcset = (path: string) =>
    [
      `https://image.tmdb.org/t/p/w300${path} 300w`,
      `https://image.tmdb.org/t/p/w500${path} 500w`,
    ].join(', ');
</script>

<script lang="ts">
  import { i18n } from '../lib/i18n.svelte';
  import DetailIcon from './DetailIcon.svelte';
  import ActionMenu from './ActionMenu.svelte';
  import { RESUME_FLOOR, WATCHED } from '../lib/actions';
  import { airDate, airWindow, cleanedOverview, futureDate } from '../lib/detailPresentation';
  import type { MenuItem } from '../lib/titleActions';
  import { outDay, type AiredEpisode } from '../lib/airing';
  import { activateLinkInPlace } from '../lib/linkActivation';
  import { playOnLabel, type HouseholdTv } from '../lib/householdTvs';
  let {
    episode,
    href,
    addressed = false,
    onaddressed,
    progress,
    busy,
    deferred = false,
    fallback,
    onplay,
    onplaytv,
    tvs = [],
    onseen,
    onsources,
    onrecheck,
    ondownload,
    downloadState,
  }: {
    episode: AiredEpisode;
    /**
     * The episode's own address (`?season=2&episode=3`). The row is a link to it, so a modified or middle click, a
     * right-click or a long press opens it like any other link; a plain click or Enter plays it, as it always has.
     */
    href: string;
    /** The address just brought this episode into view: it is marked, briefly, and `onaddressed` says when that ends. */
    addressed?: boolean;
    onaddressed?: () => void;
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
    onplaytv?: (tv: string) => void;
    /** The household's TVs, the one used last first: one Play on TV each. */
    tvs?: readonly HouseholdTv[];
    onseen: (seen: boolean) => void;
    onsources?: () => void;
    /** Ask for this episode's sources again past every cache. */
    onrecheck?: () => void;
    ondownload?: () => void;
    downloadState?: 'downloading' | 'ready';
  } = $props();
  const seen = $derived(progress >= WATCHED);
  /** Not aired yet: the row says when it airs instead of describing it. */
  const upcoming = $derived(futureDate(episode.airDate));
  /** Too far out to have a release: nothing to play, list or download. Within a week it acts like an aired one. */
  const held = $derived(airWindow(episode.airDate) === 'upcoming');
  const date = $derived(airDate(episode.airDate));
  /**
   * When an upcoming episode atlas dates is out: "Out Fri 6 Nov on Paramount+". TMDB's broadcast slot reads
   * "Airs …" as before.
   */
  const outLabel = $derived(
    upcoming && episode.airService !== undefined && episode.airDate
      ? i18n.format('episode.outOn', 'Out {date} on {service}', {
          date: outDay(episode.airDate, i18n.language),
          service: episode.airService,
        })
      : undefined,
  );
  const menuItems = $derived<MenuItem[]>([
    ...(onplaytv && !held
      ? tvs.map((tv) => ({
          kind: 'item' as const,
          label: playOnLabel(tv, tvs),
          onselect: () => onplaytv(tv.id),
        }))
      : []),
    ...(onsources && !held
      ? [{ kind: 'item' as const, label: 'Sources', onselect: onsources }]
      : []),
    ...(onrecheck && !held
      ? [{ kind: 'item' as const, label: 'Check for sources again', onselect: onrecheck }]
      : []),
    ...(ondownload && !held
      ? [
          {
            kind: 'item' as const,
            label:
              downloadState === 'ready'
                ? 'Downloaded'
                : downloadState === 'downloading'
                  ? 'Downloading'
                  : __DEN_TV__
                    ? 'Start download'
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
  const inactive = $derived(held || busy);

  /**
   * A plain click plays here, and the link is the browser's for every other: a modifier or another button opens the
   * address in a new tab or window. Prevented, the Router leaves a plain one alone (`Router.svelte`).
   */
  function press(event: MouseEvent) {
    activateLinkInPlace(event, () => {
      if (!inactive) onplay();
    });
  }
  /** Space, as on the button this row was: a link answers only Enter, and Space would scroll the page. */
  function key(event: KeyboardEvent) {
    if (event.key !== ' ') return;
    event.preventDefault();
    if (!inactive) onplay();
  }
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
    {#if outLabel}<span class="air-date" data-out
        ><time datetime={episode.airDate}>{outLabel}</time></span
      >
    {:else if upcoming}<span class="air-date"
        >Airs <time datetime={episode.airDate}>{date}</time></span
      >
    {:else if episode.overview}<span class="overview">{cleanedOverview(episode)}</span>{/if}
  </span>
{/snippet}

<li
  class="episode"
  data-spatial-item
  data-spatial-anchor
  class:seen
  class:upcoming
  class:deferred
  aria-hidden={deferred || undefined}
  data-episode={episode.number}
  data-addressed={addressed || undefined}
  onanimationend={(event) => event.target === event.currentTarget && onaddressed?.()}
>
  {#if deferred}
    <span class="episode-play">
      <span class="still"></span>
      {@render about(false)}
    </span>
    <span class="episode-menu"></span>
  {:else}
    <a
      {href}
      class="episode-play"
      aria-disabled={inactive || undefined}
      onclick={press}
      onkeydown={key}
      aria-label={held
        ? i18n.format('episode.upcoming', 'Episode {number}: {name}. Airs {date}', {
            number: episode.number,
            name: episode.name,
            date: date ?? '',
          })
        : i18n.format('episode.play', 'Play episode {number}: {name}', {
            number: episode.number,
            name: episode.name,
          })}
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
        {#if !held}<span class="play-glyph"><DetailIcon name="play" filled /></span>{/if}
        {#if progress > RESUME_FLOOR}<span class="progress"
            ><span class="progress-fill" style:width={`${seen ? 100 : progress * 100}%`}
            ></span></span
          >{/if}
      </span>
      {@render about(true)}
    </a>
    <div class="episode-menu">
      <ActionMenu
        items={menuItems}
        label={i18n.format('episode.options', 'Options for episode {number}', {
          number: episode.number,
        })}
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
    grid-template-columns: minmax(0, 1fr) var(--episode-menu-target, 44px);
    gap: 8px;
    align-items: center;
    padding: 12px;
    border-radius: 16px;

    /* Each row lays itself out from its own fixed grid. Keep its style/layout invalidation local without paint
       containment: keyboard outlines and the menu are deliberately allowed to escape the row. */
    contain: layout style;
  }

  /* An engine without `:has()` drops this rule; the TV stylesheet's focus-within fallback highlights the row there. */
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
    grid-template-columns: var(--episode-art-w, clamp(190px, 24vw, 280px)) minmax(0, 1fr);
    gap: 36px;
    align-items: start;
    width: 100%;
    border: 0;
    padding: 0;
    background: none;
    color: inherit;
    text-align: left;
    text-decoration: none;
    cursor: pointer;
    border-radius: 10px;
    scroll-margin-block: calc(var(--bar-space) + 16px) 16px;
  }

  .episode-play[aria-disabled='true'] {
    cursor: default;
  }

  /* The episode an address named: the row's hover wash, fading out once it has been seen. */
  .episode[data-addressed] {
    animation: addressed 2.4s ease-out;
  }

  @keyframes addressed {
    0%,
    40% {
      background: rgb(255 255 255 / 0.12);
    }

    100% {
      background: transparent;
    }
  }

  .episode-play:focus-visible {
    outline: var(--ring-width) solid var(--focus-ring);
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

  .progress-fill {
    display: block;
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
    width: var(--episode-menu-target, 44px);
    height: var(--episode-menu-target, 44px);
    border-radius: 50%;
    color: var(--muted);
  }

  :global(.episode-trigger:hover),
  :global(.episode-trigger[aria-expanded='true']) {
    background: #fff2;
    color: var(--fg);
  }

  :global(.episode-trigger:focus-visible) {
    outline: var(--ring-width) solid var(--focus-ring);
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
