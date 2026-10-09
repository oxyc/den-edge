<!-- A poster with its title — the one card every row uses (the TV's PosterCard). Posters come straight from
     TMDB's image CDN, which needs no key. The whole card is a link to the title, which is what lets it be
     opened in a new tab, copied, or middle-clicked like any other link on the web; the router intercepts the
     ordinary click, so navigating within the app is unchanged. A movie scout found nothing to play for is
     faded, as on the TV. -->
<script module lang="ts">
  const LANDSCAPE_STILL_SIZES = 'clamp(203px, 55.1vw, 275.5px)';
  /** Availability can be useful just before a card is seen, but need not follow the much wider art lookahead. */
  export const AVAILABILITY_AHEAD = 250;
  const landscapeStillSrcset = (path: string) =>
    [
      `https://image.tmdb.org/t/p/w300${path} 300w`,
      `https://image.tmdb.org/t/p/w500${path} 500w`,
    ].join(', ');
</script>

<script lang="ts">
  import { getContext, onDestroy } from 'svelte';
  import { availability } from '../lib/availability.svelte';
  import { observeNearViewport } from '../lib/nearViewport';
  import { pageVisibility } from '../lib/pageVisibility.svelte';
  import { ROW_NEAR } from './PosterRow.svelte';
  import { notePressed } from '../lib/detail';
  import { contentServiceContext } from '../lib/contentContext';
  import { posterReleaseBadge } from '../lib/detailPresentation';
  import type { Title } from '../lib/library';
  import { libraryStandings } from '../lib/standing.svelte';
  import ActionMenu from './ActionMenu.svelte';
  import { titleActionsContext, titleMenuItems } from '../lib/titleActions';
  import { toastContext } from '../lib/toast';

  let {
    title,
    caption,
    progress,
    live,
    href,
    continueWatching = false,
    stillPath,
    landscape = false,
    badge,
    artCaption,
    menu = true,
    onopen,
    downloadBadge,
    checkAvailability = true,
    onvisibilitychange,
  }: {
    title: Title;
    caption?: string;
    progress?: number;
    /** Where it is playing right now on some device, as a clock that ticks (`livePosition`). */
    live?: string;
    /** Where the card leads. Without one it is not a link: a card that shows a title and opens nothing. */
    href?: string;
    /** This card is on the Continue Watching row: its ⋯ offers "Remove from Continue Watching". */
    continueWatching?: boolean;
    /** Episode artwork. Download cards use the same landscape visual language as episode/Continue cards. */
    stillPath?: string;
    landscape?: boolean;
    /** Compact facts drawn over artwork, e.g. a download's percentage and Sx · Ey coordinate. */
    badge?: string;
    artCaption?: string;
    /**
     * False where a caller already draws its own per-card controls over the same corner, with their own
     * contract the shared menu doesn't replicate (`WatchlistPage`'s confirm-before-unmarking-a-series) — never
     * for a look-alike variant of this control, only to avoid two of them fighting over one corner.
     */
    menu?: boolean;
    /** Called when this card's link is followed. */
    onopen?: () => void;
    /**
     * This card is a download row (`DownloadsPage`): draws the download's own state in the badge corner —
     * queued, downloading, stalled/failed or ready — instead of the library's watched/watchlist/in-progress
     * standing, which is the *title's* state, not the download's, and must never be shown as a checkmark here.
     */
    downloadBadge?: { state: 'queued' | 'downloading' | 'trouble' | 'ready'; label: string };
    /** Download cards have their own persisted state; stream availability is unrelated and must not fade them. */
    checkAvailability?: boolean;
    /** Lets work tied to this card reuse its shared page/row/card visibility instead of adding an observer. */
    onvisibilitychange?: (visible: boolean) => void;
  } = $props();

  const titleActions = titleActionsContext();
  const content = contentServiceContext();
  const notify = toastContext();
  let actionMenu = $state<ActionMenu>();
  const hasMenu = $derived(menu && !!href);
  // TMDB's path is the poster wherever there is one; `posterUrl` is the fallback a service catalog carries for a
  // title TMDB's own path is missing here, so a row is not half placeholder.
  const poster = $derived(
    title.posterPath ? `https://image.tmdb.org/t/p/w342${title.posterPath}` : title.posterUrl,
  );
  const still = $derived(stillPath ? `https://image.tmdb.org/t/p/w500${stillPath}` : undefined);
  /**
   * The one picture that did not load, if any.
   *
   * Art can be refused as well as missing: a chart's fallback is metahub's, which redirects to another of its
   * hosts, and anything the page's CSP does not allow is blocked — leaving an empty frame where the title's
   * own name would at least have said what the card is. Naming the failed URL rather than setting a flag means
   * a card later given TMDB's own path still tries it.
   */
  let failed = $state('');
  const art = $derived(
    still && still !== failed ? still : poster && poster !== failed ? poster : undefined,
  );
  const stillSrcset = $derived(
    stillPath && art === still ? landscapeStillSrcset(stillPath) : undefined,
  );
  const portraitFallback = $derived(landscape && !!poster && art === poster);
  /** Far or retained-hidden cards keep their geometry but draw no poster; one shared observer activates nearby art. */
  const row = getContext<{ near: boolean } | undefined>(ROW_NEAR);
  const page = pageVisibility();
  let cardElement = $state<HTMLElement>();
  let imageNear = $state(false);
  let availabilityNear = $state(false);
  $effect(() => {
    if (!cardElement) return;
    // A retained hidden route still supplies the frozen frame for swipe history. Release its observer and stop new
    // image work, but preserve prior proximity so reactivation can restore loaded art without another observer turn.
    if (!page.active || row?.near === false) return;
    return observeNearViewport(cardElement, (near) => (imageNear = near), '1250px');
  });
  $effect(() => {
    if (!cardElement || !checkAvailability) return;
    if (!page.active || row?.near === false) {
      availabilityNear = false;
      return;
    }
    return observeNearViewport(
      cardElement,
      (near) => (availabilityNear = near),
      `${AVAILABILITY_AHEAD}px`,
    );
  });
  // While live art is deferred, `pageSnapshot` can materialize it only in an inert swipe copy.
  const showImage = $derived(page.active && (row?.near ?? true) && imageNear);
  $effect(() => onvisibilitychange?.(showImage));
  const faded = $derived(checkAvailability && availability.unavailable(title));
  const release = $derived(posterReleaseBadge(title));
  // A download row's own state replaces the standing badge outright: the title may well be "Seen" from an
  // earlier season, which says nothing about the episode this card is fetching.
  const standing = $derived(downloadBadge ? undefined : libraryStandings.of(title));
  const standingLabel = { watched: 'Seen', watchlist: 'On your watchlist', inProgress: 'Watching' };
  $effect(() => {
    if (checkAvailability && availabilityNear) availability.want(title);
  });

  // A pointer resting on the card, or a finger pressing it, fetches the title's details, so the page opens on an
  // answer already under way. Delayed, and dropped on `pointercancel` — what a touch that turns into a scroll
  // fires — so a swipe across a row fetches nothing. A press also leaves this card's poster for the title page
  // to paint until its details arrive (`notePressed`), as a click does for a keyboard.
  let warming: ReturnType<typeof setTimeout> | undefined;
  function intend(event: PointerEvent, ms: number) {
    if (!href || (event.type === 'pointerenter' && event.pointerType !== 'mouse')) return;
    if (event.type === 'pointerdown') notePressed(title, art);
    clearTimeout(warming);
    warming = setTimeout(() => {
      void content.query({ kind: 'prefetch.detail', title, region: 'US' }).catch(() => undefined);
    }, ms);
  }
  function drop(event: PointerEvent) {
    if (event.type === 'pointerleave' && event.pointerType !== 'mouse') return;
    clearTimeout(warming);
  }

  /**
   * A 500ms touch hold opens the ⋯ menu where the finger is — a shortcut for the button beside it, never the
   * only way there. Cancelled by more than 10px of movement or by `pointercancel`, so a swipe across the row
   * opens nothing; the click that follows a real long-press is swallowed below, so the card doesn't also navigate.
   */
  const LONG_PRESS_MS = 500;
  const LONG_PRESS_SLOP = 10;
  let longPressTimer: ReturnType<typeof setTimeout> | undefined;
  let longPressAt: { x: number; y: number } | null = null;
  let longPressFired = false;

  function pressStart(event: PointerEvent) {
    if (event.pointerType !== 'touch' || !hasMenu) return;
    longPressAt = { x: event.clientX, y: event.clientY };
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      longPressFired = true;
      longPressAt = null;
      actionMenu?.openAt(event.clientX, event.clientY);
    }, LONG_PRESS_MS);
  }
  function pressMove(event: PointerEvent) {
    if (!longPressAt) return;
    if (Math.hypot(event.clientX - longPressAt.x, event.clientY - longPressAt.y) > LONG_PRESS_SLOP)
      cancelLongPress();
  }
  function cancelLongPress() {
    clearTimeout(longPressTimer);
    longPressAt = null;
  }
  function cardClick(event: MouseEvent) {
    if (longPressFired) {
      longPressFired = false;
      event.preventDefault();
      return;
    }
    notePressed(title, art);
    onopen?.();
  }
  /** The ContextMenu key or Shift+F10 on the focused card, same as a right-click on it. */
  function cardKeydown(event: KeyboardEvent) {
    if (!hasMenu) return;
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    actionMenu?.openAt(rect.right, rect.top);
  }
  /** A right-click opens the same menu; Shift+right-click is left to the browser's own. */
  function cardContextMenu(event: MouseEvent) {
    if (event.shiftKey || !hasMenu) return;
    event.preventDefault();
    actionMenu?.openAt(event.clientX, event.clientY);
  }
  onDestroy(() => {
    clearTimeout(warming);
    clearTimeout(longPressTimer);
  });
</script>

{#snippet body()}
  <span
    class="art"
    class:landscape
    data-snapshot-poster={art && !showImage ? art : undefined}
    data-snapshot-fit={art && !showImage && portraitFallback ? 'contain' : undefined}
  >
    {#if art}
      {#if showImage}
        <img
          class:contained={portraitFallback}
          src={art}
          srcset={stillSrcset}
          sizes={stillSrcset ? LANDSCAPE_STILL_SIZES : undefined}
          alt=""
          loading="lazy"
          decoding="async"
          onerror={() => (failed = art ?? '')}
        />
      {/if}
    {:else}
      <span class="placeholder">{title.title}</span>
    {/if}
    {#if artCaption}<span class="art-caption" class:raised={progress}>{artCaption}</span>{/if}
    {#if badge}<span class="badge">{badge}</span>{/if}
    {#if title.rating}
      <span
        class="rating"
        aria-label="{title.ratingSource === 'justwatch-imdb'
          ? 'IMDb'
          : 'TMDB'} rating {title.rating.toFixed(1)}"
        >{title.ratingSource === 'justwatch-imdb' ? 'IMDb' : '★'} {title.rating.toFixed(1)}</span
      >
    {/if}
    {#if release}
      <time class="release" datetime={release.date} aria-label={release.accessibilityLabel}
        >{release.text}</time
      >
    {/if}
    {#if live}
      <span class="live" class:raised={progress}>▶ {live}</span>
    {/if}
    {#if downloadBadge}
      <span
        class="standing download-{downloadBadge.state}"
        class:raised={progress}
        role="img"
        aria-label={downloadBadge.label}
        title={downloadBadge.label}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {#if downloadBadge.state === 'queued'}
            <circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v5l3.2 2" />
          {:else if downloadBadge.state === 'downloading'}
            <path d="M12 4.5v10m0 0l-3.5-3.5m3.5 3.5l3.5-3.5" /><path d="M5.5 18.5h13" />
          {:else if downloadBadge.state === 'trouble'}
            <path d="M12 8v4.5" /><path d="M12 16v.01" /><circle cx="12" cy="12" r="8.5" />
          {:else}
            <path
              class="filled"
              d="M12 4v9.5l-3.5-3.5-1.4 1.4 5.9 5.9 5.9-5.9-1.4-1.4-3.5 3.5V4z"
            />
            <path d="M5.5 19.5h13" />
          {/if}
        </svg>
      </span>
    {:else if standing}
      <span
        class="standing"
        class:raised={progress}
        role="img"
        aria-label={standingLabel[standing]}
        title={standingLabel[standing]}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {#if standing === 'watched'}
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          {:else if standing === 'watchlist'}
            <path class="filled" d="M7 4h10v16l-5-3.5L7 20z" />
          {:else}
            <path class="filled" d="M8 5.5v13l10.5-6.5z" />
          {/if}
        </svg>
      </span>
    {/if}
    {#if progress !== undefined && progress > 0}
      <span class="progress" style:--p={progress}></span>
    {/if}
  </span>
  <span class="meta">
    <span class="name">{title.title}</span>
    {#if caption}<span class="caption">{caption}</span>{/if}
  </span>
{/snippet}

{#snippet card()}
  {#if href}
    <a
      bind:this={cardElement}
      class="card pick"
      class:landscape
      class:faded
      {href}
      onclick={cardClick}
      onkeydown={cardKeydown}
      oncontextmenu={cardContextMenu}
      onpointerenter={(event) => intend(event, 100)}
      onpointerdown={(event) => {
        intend(event, 60);
        pressStart(event);
      }}
      onpointermove={pressMove}
      onpointerup={cancelLongPress}
      onpointerleave={(event) => {
        drop(event);
        cancelLongPress();
      }}
      onpointercancel={(event) => {
        drop(event);
        cancelLongPress();
      }}>{@render body()}</a
    >
  {:else}
    <figure bind:this={cardElement} class="card" class:faded class:landscape>
      {@render body()}
    </figure>
  {/if}
{/snippet}

{#snippet ellipsis()}
  <span aria-hidden="true">⋯</span>
{/snippet}

{#if hasMenu}
  <div class="holder" class:landscape>
    {@render card()}
    <ActionMenu
      bind:this={actionMenu}
      items={() => titleMenuItems(title, titleActions, { continueWatching, href: href!, notify })}
      label={`Actions for ${title.title}`}
      heading={title.title}
      triggerClass={release ? 'action below' : 'action'}
      glyph={ellipsis}
    />
  </div>
{:else}
  {@render card()}
{/if}

<style>
  .card {
    margin: 0;
    width: var(--card-w);
  }

  .pick {
    display: block;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    text-align: left;
    text-decoration: none;
    cursor: pointer;
  }

  .art {
    position: relative;
    display: block;
    aspect-ratio: 2 / 3;
    max-width: 100%;
    overflow: hidden;
    border-radius: 12px;
    background: var(--card);
  }

  .art.landscape {
    aspect-ratio: 16 / 9;
  }

  .card.landscape,
  .holder.landscape {
    width: calc(var(--card-w) * 1.45);
  }

  /* The TV's fade: dim, and less so under the pointer or focus so the card stays legible. */
  .faded .art {
    opacity: 0.5;
  }

  .faded:hover .art,
  .faded:focus-visible .art {
    opacity: 0.8;
  }

  /* One ring, the artwork's, drawn inside its edge: the browser's own ring around the whole link made two,
     and one drawn outside was cut off by the row, which clips what overflows it vertically. */
  .pick:focus-visible {
    outline: none;
  }

  .pick:focus-visible .art {
    outline: 3px solid var(--accent);
    outline-offset: -3px;
  }

  /* Chromium carries a keyboard focus-visible state across an async card replacement. RoutePage marks a focus
     restored after touch until the viewer presses a key, so that replacement does not grow a false ring. */
  :global([data-restored-pointer-focus]) .pick:focus-visible .art {
    outline: none;
  }

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;

    /* iOS's own "save image" sheet would otherwise race the long-press that opens the ⋯ menu. */
    -webkit-touch-callout: none;
  }

  img.contained {
    object-fit: contain;
  }

  .badge,
  .art-caption {
    position: absolute;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgb(0 0 0 / 0.72);
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .badge {
    top: 8px;
    right: 8px;
  }

  .art-caption {
    bottom: 8px;
    left: 8px;
  }

  .art-caption.raised {
    bottom: 18px;
  }

  .placeholder {
    display: grid;
    height: 100%;
    place-items: center;
    padding: 12px;
    color: var(--muted);
    font-size: 14px;
    text-align: center;
  }

  .rating {
    position: absolute;
    top: 8px;
    left: 8px;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgb(0 0 0 / 0.72);
    font-size: 12px;
    font-weight: 600;
  }

  .release {
    position: absolute;
    top: 8px;
    right: 8px;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgb(0 0 0 / 0.72);
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .progress {
    position: absolute;
    right: 8px;
    bottom: 8px;
    left: 8px;
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(
      to right,
      var(--fg) calc(var(--p) * 100%),
      rgb(255 255 255 / 0.3) 0
    );
  }

  /* Above the progress bar where there is one. */
  .live,
  .standing {
    position: absolute;
    bottom: 8px;
  }

  .live.raised,
  .standing.raised {
    bottom: 18px;
  }

  .live {
    left: 8px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--on-accent, #fff);
    font-size: 12px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .standing {
    right: 8px;
    display: grid;
    width: 24px;
    height: 24px;
    place-items: center;
    border-radius: 999px;
    background: rgb(0 0 0 / 0.72);
  }

  .standing svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: var(--fg);
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 2.5;
  }

  .standing .filled {
    fill: var(--fg);
  }

  /* Stalled or failed: the same orange `DownloadStatus` turns its headline. */
  .standing.download-trouble svg {
    stroke: #ffc177;
  }

  .standing.download-trouble .filled {
    fill: #ffc177;
  }

  .holder {
    position: relative;
    width: var(--card-w);
  }

  .holder .card {
    width: auto;
  }

  /* The ⋯ trigger renders inside `ActionMenu`, a child component, so these reach it the same way `Detail`
     reaches `DetailMedia`'s `.expand` — a plain class name is scoped to its own component, `:global` isn't. */
  :global(.holder .action) {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 32px;
    height: 32px;
    border: 1px solid rgb(255 255 255 / 0.25);
    border-radius: 999px;
    background: rgb(0 0 0 / 0.72);
    font-size: 16px;
    line-height: 1;
    opacity: 0;
    transition: opacity 120ms;
  }

  /* Under the release badge, which has the corner. */
  :global(.holder .action.below) {
    top: 38px;
  }

  :global(.holder .action:hover) {
    background: rgb(0 0 0 / 0.9);
  }

  :global(.holder .action:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    opacity: 1;
  }

  :global(.holder .action[aria-expanded='true']) {
    opacity: 1;
  }

  .holder:hover :global(.action) {
    opacity: 1;
  }

  /* Touch: nothing to hover, so it is always there — smaller, and quiet enough not to cover the art. */
  @media (hover: none) {
    :global(.holder .action) {
      width: 28px;
      height: 28px;
      font-size: 14px;
      opacity: 0.8;
    }
  }

  .meta {
    display: grid;
    margin-top: 8px;
    min-height: 2.8em;
    grid-template-rows: 1.4em 1.4em;
    font-size: 14px;
    line-height: 1.4;
  }

  .name {
    overflow: hidden;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .caption {
    overflow: hidden;
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
