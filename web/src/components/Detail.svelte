<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import DetailMedia from './DetailMedia.svelte';
  import { stableViewportHeight } from '../lib/stableViewportHeight';
  import type { Routes } from '../lib/routes';
  import Loading from './Loading.svelte';
  import { type Credit, type Episode, type TitleDetail } from '../lib/detail';
  import {
    episodeProgress,
    markableEpisodes,
    seriesPresentation,
    seriesSeenOverride,
    type Ratings,
  } from '../lib/detailPresentation';
  import { RESUME_FLOOR, WATCHED } from '../lib/actions';
  import type { MediaType, Title } from '../lib/library';
  import type { EpisodeRow, TitleRow } from '../lib/wire';
  import PersonCard from './PersonCard.svelte';
  import PosterRow from './PosterRow.svelte';
  import TitleActions from './TitleActions.svelte';
  import TitleMetadata from './TitleMetadata.svelte';
  import ProductionMetadata from './ProductionMetadata.svelte';
  import DetailTabs from './DetailTabs.svelte';
  import EpisodeCard from './EpisodeCard.svelte';
  import SeasonDownload from './SeasonDownload.svelte';
  import { downloadEpisode } from '../lib/seasonDownloads.svelte';
  import DetailIcon from './DetailIcon.svelte';
  import RelatedTitles from './RelatedTitles.svelte';
  import TitleSources from './TitleSources.svelte';
  import { isBlocked } from '../lib/parental';
  import { blockedTitles } from '../lib/blockedTitles.svelte';
  import Trailer from './Trailer.svelte';
  import { sharedInstallOf } from '../lib/grants';
  import { premeasureLink } from '../lib/remux';
  import type { Addon } from '../lib/scout';
  import { navigateBack } from '../lib/navigation';
  import { named } from '../lib/pageTitle';
  import { nameTab } from '../lib/tabName.svelte';
  import { titleHref } from '../lib/route';
  import type { IconicStudio } from '../lib/iconicStudios';
  import { NO_FACTS, type TitleFacts } from '../lib/titleFacts';
  import { toastContext } from '../lib/toast';
  import { whenIdle } from '../lib/idle';
  import { observeNearViewport } from '../lib/nearViewport';
  import { yieldTask } from '../lib/taskYield';
  import type { LibraryModel, LibraryModelLease } from '../lib/libraryModel.svelte';
  import type { DownloadsView } from '../lib/libraryServiceProtocol';
  import type { ContentServiceClientPort } from '../lib/contentServiceClient';
  import type { Warning } from '../lib/contentWarnings';

  type Reaction = TitleRow['reaction']['value'];
  let {
    ref,
    active = true,
    reel = null,
    routes = {},
    atlas = null,
    content,
    warningCategories = [],
    region = 'US',
    autoplay = true,
    scout = null,
    ratingSources = ['imdb', 'tmdb', 'rottenTomatoes', 'metacritic'],
    row,
    episodes,
    busy,
    failure,
    notice,
    onwatchlist,
    onseen,
    onreact,
    onplay,
    onplayhere,
    remux = null,
    away = false,
    blocked = false,
    ceiling = undefined,
    onepisode,
    onseason,
    shown = () => true,
    seed,
    still,
    model,
  }: {
    ref: { type: MediaType; id: number };
    active?: boolean;
    reel?: string | null;
    routes?: Routes;
    /** Where this page reaches atlas, whose index names the titles closest to this one; null where it can't. */
    atlas?: string | null;
    /** The Worker-owned, normalized content boundary. Provider keys never enter this component. */
    content: ContentServiceClientPort;
    warningCategories?: string[];
    region?: string;
    ratingSources?: string[];
    autoplay?: boolean;
    scout?: Addon | null;
    row: TitleRow | undefined;
    episodes: Map<string, EpisodeRow>;
    busy: boolean;
    failure: string | null;
    notice: string | null;
    onwatchlist: (title: Title, on: boolean) => void;
    onseen: (title: Title, on: boolean) => void;
    onreact: (title: Title, reaction: Reaction) => void;
    /** Absent for a guest, who has no TV to send to — `TitleActions` already omits the button without it. */
    onplay?: (title: Title, season?: number, episode?: number) => void;
    onplayhere?: (title: Title, season?: number, episode?: number, filename?: string) => void;
    /** Where den-remux answers (`findRemux`) for playback and link premeasurement. */
    remux?: string | null;
    /** A library member whose device reaches no den-remux route, so nothing plays here: `TitleActions` says where it does. */
    away?: boolean;
    /** That device was refused the home network by the browser itself, which `TitleActions` says instead. */
    blocked?: boolean;
    /**
     * The household's parental ceiling (`den.maturityCeiling`). A title rated above it loses Play, Sources,
     * its episodes and its trailer, exactly as on the TV (`DetailView+Sections.parentalBlocked`).
     */
    ceiling?: 'pg13' | 'r';
    onepisode: (title: Title, season: number, episode: number, seen: boolean) => void;
    /**
     * Mark a whole season at once, in one write rather than one per episode. Optional: a surface that has no
     * way to write a season simply shows no season control, rather than one that half works.
     */
    onseason?: (title: Title, season: number, episodes: number[], seen: boolean) => void;
    shown?: (title: Title) => boolean;
    /**
     * What the page that linked here already knew about this title.
     *
     * Only its artwork is wanted: TMDB is asked for the rest, and until it answers this hero had
     * nothing to paint but a grey placeholder — so opening a title from Home went picture, blank,
     * picture. The row or billboard that was just pressed is holding the poster and backdrop.
     */
    seed?: Title;
    /**
     * The poster the pressed card was showing (`notePressed`). It is already loaded, so it paints with the page,
     * under the backdrop that has yet to arrive.
     */
    still?: string;
    model?: LibraryModel | null;
  } = $props();

  /** The backdrop the hero will end up using, where the page that linked here knew it. */
  const seedStill = $derived(
    seed?.backdropPath ? `https://image.tmdb.org/t/p/w1280${seed.backdropPath}` : null,
  );
  /**
   * Otherwise a poster, the pressed card's own first: drawn blurred and dimmed under the backdrop, the way a title
   * with no backdrop shows its poster (`DetailMedia`). Sharp, a portrait picture cropped to the hero's frame read
   * as a zoom when the backdrop replaced it.
   */
  const placeholder = $derived(
    seedStill
      ? undefined
      : (still ??
          (seed?.posterPath ? `https://image.tmdb.org/t/p/w780${seed.posterPath}` : undefined)),
  );
  const DETAIL_POSTER_SIZES =
    '(max-width: 759px) clamp(96px, 22vw, 180px), clamp(110px, 11vw, 160px)';
  const detailPosterSrcset = (path: string) =>
    [
      `https://image.tmdb.org/t/p/w342${path} 342w`,
      `https://image.tmdb.org/t/p/w500${path} 500w`,
    ].join(', ');
  const panel = $props.id();

  /**
   * Left and Escape leave the page, as the remote's Back does on the TV — a title you opened with one press
   * should close with one.
   *
   * Only from the page itself. A key pressed while typing is text, not navigation; one another control has
   * already answered is spoken for; and Escape inside full screen belongs to the video, which the browser
   * takes before this ever sees it.
   */
  $effect(() => {
    if (!active) return;
    const back = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'Escape') return;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (document.fullscreenElement) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable]')
      ) {
        return;
      }
      event.preventDefault();
      navigateBack();
    };
    window.addEventListener('keydown', back);
    return () => window.removeEventListener('keydown', back);
  });
  /**
   * Whether the trailer is open in YouTube's embed.
   *
   * The way a viewer sees a trailer when this page cannot play one itself — no HLS master for it, the
   * media refused, a browser that plays neither. Until now the button left the site for YouTube, so
   * every such case read as "no trailer here".
   */
  let trailerOpen = $state(false);
  /**
   * A scout shared through a grant answers no `/stream` or `/play` (den-edge refuses both on its `~<gid>` base), so
   * the release list and downloads are not offered: a guest plays through den-remux alone.
   */
  const guestScout = $derived(!!scout && !!sharedInstallOf(scout.install));
  const downloadLease: LibraryModelLease<DownloadsView> | undefined = untrack(() =>
    model?.downloads(),
  );
  onDestroy(() => downloadLease?.release());
  // Away from home a play asks den-remux for a session that fits the link. Timing it while this page is read lets the
  // first play's request carry it, rather than start a session only to measure and start another. Given up on when
  // the page stops being the active one — which pressing Play does.
  $effect(() => {
    if (!active || !onplayhere || !remux) return;
    return premeasureLink(remux);
  });
  let sourcesPanel = $state<TitleSources>();
  const notify = toastContext();
  let sourceTarget = $state<{ season: number; episode: number } | undefined>();
  /**
   * TMDB answers are immutable here: each refresh replaces the whole answer. Keep them shallow-reactive so the
   * first detail flush does not proxy every property and array walk. In a 4x-CPU trace, the tracked cast merge alone
   * spent 24 ms in this flush.
   */
  let detail = $state.raw<TitleDetail | null | undefined>();
  /** The curated studios credited on this title; undefined while they are asked for. */
  let iconicStudios = $state.raw<IconicStudio[] | undefined>();
  /** atlas's facts about this title; undefined while they are asked for. */
  let titleFacts = $state.raw<TitleFacts | undefined>();
  /** The cast row shows the top of the bill and goes on as it is scrolled to its end: a long series lists hundreds. */
  const CAST_PAGE = 20;
  let castShown = $state(CAST_PAGE);
  /**
   * PersonCard and BrowseRow are the deep trees at the foot of a detail page. Keep their final geometry in the
   * first detail flush, but do not put all of their live DOM in it: the phone trace's single ~40 ms ParseHTML task
   * was mostly these two sections. A scroll promotes them at once; otherwise they begin after paint, in idle time.
   */
  const CAST_DOM_CHUNK = 4;
  let castMounted = $state(0);
  let tailStarted = $state(false);
  let tailRoot = $state<HTMLDivElement>();
  function castEnd(node: HTMLElement) {
    $effect(() => {
      if (!active || castShown >= cast.length) return;
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) castShown += CAST_PAGE;
        },
        { rootMargin: '200px' },
      );
      observer.observe(node);
      return () => observer.disconnect();
    });
  }
  /**
   * Whether the household's ceiling blocks this title. The page still exists — it names the title, its year and
   * its rating, as the TV's does — but nothing that plays it is offered: no Play, no Sources, no episodes and no
   * trailer. Unknown ratings are not blocked (`parental.isBlocked`), so an unrated title reads as it always did.
   */
  const restricted = $derived(!!detail && isBlocked(detail.certifications, region, ceiling));
  // Shared with the poster's own ⋯ menu (`blockedTitles.ts`), so it can hide Play for a title this browser
  // already knows the household's ceiling refuses, without a certification fetch of its own.
  $effect(() => {
    if (detail) blockedTitles.mark(ref, restricted);
  });
  let season = $state<number | null>(null);
  let seasonEpisodes = $state.raw<Episode[] | null | undefined>();
  let displayedSeason = $state<number | null>(null);
  let seasonLoading = $state(false);
  /**
   * Episode cards are comparatively deep trees (art, progress, actions and a menu). A long season used to create
   * every one in the promise callback's single Svelte flush: 50 cards added 941 nodes and one 56 ms task at 4x CPU.
   * Keep the list's complete geometry from the first paint, then replace its inert slots a few cards per task.
   */
  const EPISODE_CHUNK = 4;
  let episodeLimit = $state(0);
  let retry = $state(0),
    seasonRetry = $state(0);
  let ratings = $state.raw<Ratings | null>(null);
  let warnings = $state.raw<Warning[] | undefined>();

  // Props arrive through one component input object. Publishing an unrelated one (for example fresh library rows
  // after a provider sync) can therefore make expressions that read `ref` or the region run again even when both
  // values are unchanged. Keep the request behind a primitive identity: re-evaluating this derived
  // to the same string does not tear down the loaded detail — and its playing `DetailMedia` — just because another
  // prop changed.
  const detailRequest = $derived(`${ref.type}:${ref.id}\u0000${region}`);
  $effect(() => {
    void detailRequest;
    const [current, country] = untrack(() => [{ type: ref.type, id: ref.id }, region] as const);
    void retry;
    const controller = new AbortController();
    detail = undefined;
    season = null;
    seasonEpisodes = undefined;
    displayedSeason = null;
    castShown = CAST_PAGE;
    castMounted = 0;
    tailStarted = false;
    void content
      .query({ kind: 'title.detail', title: current, region: country }, controller.signal)
      .then(({ detail: loaded }) => {
        if (controller.signal.aborted) return;
        detail = loaded.state === 'ready' ? loaded.value : null;
        season = detail ? seriesPresentation(detail, episodes, row).initialSeason : null;
      })
      .catch(() => {
        if (!controller.signal.aborted) detail = null;
      });
    return () => controller.abort();
  });

  // A different season starts with its first screenful. Fixed slots below it keep later sections and saved scroll
  // positions still while the rest is filled in; none are capped, and every episode becomes an ordinary card.
  $effect(() => {
    const [loaded, picked] = [seasonEpisodes, displayedSeason];
    untrack(() => {
      episodeLimit = loaded && picked !== null ? Math.min(EPISODE_CHUNK, loaded.length) : 0;
    });
  });

  // One task boundary per small batch gives input and paint a chance between cards. Leaving this retained page stops
  // its remaining work; returning continues from the first batch rather than filling a hidden route in the meantime.
  $effect(() => {
    const [loaded, picked, visible] = [seasonEpisodes, displayedSeason, active];
    if (!visible || !loaded || picked === null || loaded.length <= EPISODE_CHUNK) return;
    let live = true;
    void (async () => {
      while (live && untrack(() => episodeLimit) < loaded.length) {
        await yieldTask();
        if (
          !live ||
          !active ||
          untrack(() => seasonEpisodes) !== loaded ||
          untrack(() => displayedSeason) !== picked
        )
          return;
        episodeLimit = Math.min(loaded.length, untrack(() => episodeLimit) + EPISODE_CHUNK);
      }
    })();
    return () => {
      live = false;
    };
  });

  const extrasRequest = $derived(
    `${ref.type}:${ref.id}\u0000${warningCategories.slice().sort().join('\u0001')}`,
  );
  $effect(() => {
    void extrasRequest;
    ratings = null;
    warnings = undefined;
    iconicStudios = undefined;
    titleFacts = undefined;
  });

  // Optional providers are one independent Worker question. They may finish after base detail and seasons, and a
  // retained hidden route does no provider work until it is visible again.
  $effect(() => {
    void extrasRequest;
    const [visible, loaded] = [active, detail];
    if (!visible || !loaded) return;
    const title = untrack(() => ({ type: ref.type, id: ref.id }));
    const categories = untrack(() => [...warningCategories]);
    const controller = new AbortController();
    void content
      .query(
        {
          kind: 'title.extras' as const,
          title,
          warningCategories: categories,
        },
        controller.signal,
      )
      .then(({ extras }) => {
        if (controller.signal.aborted) return;
        ratings = extras.ratings.state === 'ready' ? extras.ratings.value : null;
        warnings = extras.warnings.state === 'ready' ? extras.warnings.value : [];
        iconicStudios = extras.iconicStudios.state === 'ready' ? extras.iconicStudios.value : [];
        titleFacts = extras.facts.state === 'ready' ? extras.facts.value : NO_FACTS;
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        warnings = [];
        iconicStudios = [];
        titleFacts = NO_FACTS;
      });
    return () => controller.abort();
  });

  $effect(() => {
    const [picked, current] = [season, ref];
    void seasonRetry;
    if (picked === null || current.type !== 'tv') return;
    const controller = new AbortController();
    seasonLoading = true;
    void content
      .query(
        { kind: 'season', title: { type: 'tv', id: current.id }, season: picked },
        controller.signal,
      )
      .then(({ episodes: loaded }) => {
        if (controller.signal.aborted) return;
        seasonEpisodes = loaded.state === 'ready' ? loaded.value : null;
        displayedSeason = picked;
        seasonLoading = false;
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        seasonEpisodes = null;
        displayedSeason = picked;
        seasonLoading = false;
      });
    return () => controller.abort();
  });

  // The page names itself once TMDB has answered. Until then the tab reads "Den", which is all the address
  // can say: a bookmark or a second tab full of titles is otherwise twenty pages with the same name.
  nameTab(() =>
    active && detail?.title.title ? named(detail.title.title, detail.title.year) : null,
  );

  const series = $derived(detail ? seriesPresentation(detail, episodes, row) : null);
  const seenOverride = $derived(ref.type === 'tv' ? seriesSeenOverride(series) : undefined);
  const target = $derived(ref.type === 'tv' ? series?.target : undefined);
  const sourceCoord = $derived(sourceTarget ?? target);
  const fraction = $derived(
    ref.type === 'tv' ? (series?.fraction ?? 0) : row && !row.deleted.value ? row.resume.value : 0,
  );
  const continuing = $derived(
    (fraction > RESUME_FLOOR && fraction < WATCHED) ||
      (ref.type === 'tv' && series?.kind === 'next'),
  );
  const continueLabel = $derived(
    series?.kind === 'next' && target
      ? `Play Next · S${target.season} · E${target.episode}`
      : 'Continue Watching',
  );
  /** Directors lead the row, followed by cast in billing order, once per person. */
  const creditedPeople = (loaded: TitleDetail): Credit[] => {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- ephemeral deduplication inside one derived evaluation.
    const seen = new Set<number>();
    const people: Credit[] = [];
    for (const credits of [loaded.directors, loaded.cast])
      for (const credit of credits) {
        if (seen.has(credit.id)) continue;
        seen.add(credit.id);
        people.push(credit);
      }
    return people;
  };
  const cast = $derived(detail ? creditedPeople(detail) : []);
  const castTarget = $derived(Math.min(castShown, cast.length));
  const castRemaining = $derived(Math.max(0, castTarget - castMounted));
  const relatedMayMount = $derived(tailStarted && castMounted >= castTarget);

  // Register only while this retained page is in front. Two animation frames put the idle request after its first
  // paint; a real scroll or the reserved tail nearing the viewport bypasses that wait so content is ready when the
  // viewer asks for it. All three paths converge on one idempotent flag and are torn down on route deactivation.
  $effect(() => {
    const current = detail;
    if (!active || !current || tailStarted || !tailRoot) return;
    let live = true;
    let firstFrame: number | undefined;
    let paintedFrame: number | undefined;
    let cancelIdle = () => {};
    let initialScrollY: number | undefined;
    const start = () => {
      if (live && active && detail === current) tailStarted = true;
    };
    const startOnScroll = () => {
      // Before the first paint there is no clean layout from which to sample a baseline. Treat an early scroll as
      // demand; otherwise compare against the baseline captured once the first paint has completed.
      if (initialScrollY === undefined || window.scrollY !== initialScrollY) start();
    };
    const stopNear = observeNearViewport(tailRoot, (near) => near && start(), '800px 0px');
    window.addEventListener('scroll', startOnScroll, { passive: true });
    firstFrame = requestAnimationFrame(() => {
      firstFrame = undefined;
      paintedFrame = requestAnimationFrame(() => {
        paintedFrame = undefined;
        if (live) {
          // The trace showed that reading scrollY in the mounting effect synchronously flushed the whole detail
          // layout. A nested frame places this read after one completed paint, when geometry is already clean.
          initialScrollY = window.scrollY;
          cancelIdle = whenIdle(start);
        }
      });
    });
    return () => {
      live = false;
      if (firstFrame !== undefined) cancelAnimationFrame(firstFrame);
      if (paintedFrame !== undefined) cancelAnimationFrame(paintedFrame);
      cancelIdle();
      stopNear();
      window.removeEventListener('scroll', startOnScroll);
    };
  });

  // The first promoted batch is small enough to mount in the observer/idle callback's own task. Every later batch
  // crosses a task boundary. A hidden retained page stops at its current batch and resumes from there on Back.
  $effect(() => {
    const [people, target, visible, started] = [cast, castTarget, active, tailStarted];
    if (!visible || !started || untrack(() => castMounted) >= target) return;
    let live = true;
    void (async () => {
      let first = true;
      while (live && untrack(() => castMounted) < target) {
        if (!first) await yieldTask();
        first = false;
        if (
          !live ||
          !active ||
          !tailStarted ||
          untrack(() => cast) !== people ||
          untrack(() => castTarget) !== target
        )
          return;
        castMounted = Math.min(target, untrack(() => castMounted) + CAST_DOM_CHUNK);
      }
    })();
    return () => {
      live = false;
    };
  });
  /** What a season-wide press may write here: nothing on Specials, and nothing that has yet to air. */
  const seasonMarkable = $derived(markableEpisodes(displayedSeason, seasonEpisodes));
  const seasonSeen = $derived(
    seasonMarkable.length > 0 &&
      seasonMarkable.every(
        (number) => episodeProgress(episodes.get(`${displayedSeason}:${number}`), row) >= WATCHED,
      ),
  );
  /** One write for the whole season rather than one per episode — the difference is ~2 requests against ~20. */
  function markSeason(seen: boolean) {
    const d = untrack(() => detail);
    if (!d || displayedSeason === null) return;
    onseason?.(d.title, displayedSeason, seasonMarkable, seen);
  }

  function playEpisode(number: number) {
    const d = untrack(() => detail),
      picked = untrack(() => displayedSeason);
    // A guest has neither, so there is nothing to start and the episode row simply does not act.
    if (d && picked !== null) (onplayhere ?? onplay)?.(d.title, picked, number);
  }

  async function queueEpisode(episode: Episode) {
    const d = untrack(() => detail),
      picked = untrack(() => displayedSeason);
    if (!d || !model || guestScout || !d.imdbId || picked === null) return;
    const result = await downloadEpisode(model, d.imdbId, picked, episode, d.title);
    if (result === 'ready') notify?.('This episode is already ready to play.');
    else if (result === 'unavailable')
      notify?.('No downloadable release was found for that episode.');
    else if (result === 'uncertain')
      notify?.('Couldn’t start that download. Try again in a moment.');
  }
</script>

{#if detail === null}
  <p class="note">Couldn’t load this title from TMDB.</p>
  <button class="retry" onclick={() => retry++}>Try again</button>
{:else}
  <!-- One hero, and one picture frame in it, from the moment the page opens until it is left: TMDB's answer fills
       them in rather than replacing them, so the frame is never a different element, measured again. -->
  <header
    class="hero"
    use:stableViewportHeight
    aria-busy={detail ? undefined : 'true'}
    aria-label={detail ? undefined : 'Loading title'}
  >
    <div class="visual" aria-hidden={detail ? undefined : 'true'}>
      {#if detail}
        <DetailMedia
          {placeholder}
          autoplay={autoplay && !restricted}
          type={ref.type}
          tmdbId={ref.id}
          imdbId={detail.imdbId}
          {active}
          {reel}
          {routes}
          backdrop={detail.backdropPath
            ? `https://image.tmdb.org/t/p/w1280${detail.backdropPath}`
            : undefined}
          poster={detail.title.posterPath
            ? `https://image.tmdb.org/t/p/w780${detail.title.posterPath}`
            : undefined}
        />
      {:else if seedStill}
        <img class="seed-still" src={seedStill} alt="" />
      {:else if placeholder}
        <img class="seed-still blurred" src={placeholder} alt="" />
      {:else}
        <!-- A spinner only where there is nothing to look at, and only in the picture's own frame. Not
             `page`: that asks the router to hold the page the viewer just left over this one until TMDB
             answers, when this skeleton is already the page's own placeholder. -->
        <div class="still-loading"><Loading label="Loading title" /></div>
      {/if}
    </div>
    {#if !detail}
      <div class="hero-content" aria-hidden="true">
        <div class="head">
          {#if seed?.posterPath}
            <img
              class="poster"
              src="https://image.tmdb.org/t/p/w500{seed.posterPath}"
              srcset={detailPosterSrcset(seed.posterPath)}
              sizes={DETAIL_POSTER_SIZES}
              alt=""
              width="280"
              height="420"
            />
          {:else}<span class="poster placeholder"></span>{/if}
          <div class="loading-copy">
            <span class="placeholder loading-title"></span><span class="placeholder loading-facts"
            ></span>
          </div>
        </div>
        <div class="hero-actions loading-slot"><div class="loading-actions placeholder"></div></div>
      </div>
    {:else}
      {@const d = detail}
      <div class="hero-content">
        <div class="head">
          {#if d.title.posterPath}<img
              class="poster"
              src="https://image.tmdb.org/t/p/w500{d.title.posterPath}"
              srcset={detailPosterSrcset(d.title.posterPath)}
              sizes={DETAIL_POSTER_SIZES}
              alt=""
              width="280"
              height="420"
            />
          {:else}<span class="poster placeholder" aria-hidden="true"></span>{/if}
          <div class="copy">
            <h1>{d.title.title}</h1>
            <TitleMetadata
              detail={d}
              {ratings}
              enabled={ratingSources}
              pending={!!d.imdbId && ratingSources.some((s) => s !== 'tmdb')}
              {warnings}
              {region}
            />
            {#if d.overview}<p class="overview desktop-overview">{d.overview}</p>{/if}
            <div class="desktop-overview">
              <ProductionMetadata detail={d} studios={iconicStudios} facts={titleFacts} />
            </div>
            {#if d.imdbId}<p class="awards desktop-overview" title={ratings?.awards}>
                {ratings?.awards ? ratings.awards : ''}
              </p>{/if}
          </div>
        </div>
        {#if continuing}
          <button
            class="continue"
            onclick={() => (onplayhere ?? onplay)?.(d.title, target?.season, target?.episode)}
          >
            <DetailIcon name="play" filled /><span
              ><strong>{continueLabel}</strong>
              {#if target && series?.kind === 'resume'}<small
                  >S{target.season} · E{target.episode}</small
                >{/if}
              {#if fraction > RESUME_FLOOR && fraction < WATCHED}<span class="resume-track"
                  ><span style:width={`${fraction * 100}%`}></span></span
                >{/if}
            </span>
          </button>
        {/if}
        <div class="hero-actions">
          <TitleActions
            {row}
            {busy}
            {failure}
            {notice}
            detailPage
            playLabel={continuing ? 'Resume' : 'Play'}
            onwatchlist={(on) => onwatchlist(d.title, on)}
            onseen={(on) => onseen(d.title, on)}
            {seenOverride}
            onreact={(reaction) => onreact(d.title, reaction)}
            onplay={onplay ? () => onplay(d.title, target?.season, target?.episode) : undefined}
            onplayhere={onplayhere
              ? () => onplayhere(d.title, target?.season, target?.episode)
              : undefined}
            {away}
            {blocked}
            {restricted}
            trailerHref={d.trailer
              ? `https://www.youtube.com/watch?v=${encodeURIComponent(d.trailer)}`
              : `https://www.youtube.com/results?search_query=${encodeURIComponent([d.title.title, d.title.year, 'official trailer'].filter(Boolean).join(' '))}`}
            ontrailer={d.trailer ? () => (trailerOpen = true) : undefined}
            share={{
              title: d.title.title,
              // The title's own address, named: what the person sharing it means, and what a preview can
              // describe. Built from the route rather than from wherever this page happens to be open.
              url: `${location.origin}${titleHref(d.title)}`,
            }}
          />
        </div>
      </div>
    {/if}
  </header>
  {#if !detail}
    <div class="loading-overview placeholder" aria-hidden="true"></div>
  {:else}
    {@const d = detail}
    {#if trailerOpen && d.trailer}
      <Trailer key={d.trailer} title={d.title.title} onclose={() => (trailerOpen = false)} />
    {/if}
    <div class="mobile-overview">
      {#if d.overview}<p class="overview">{d.overview}</p>{/if}
      <ProductionMetadata detail={d} studios={iconicStudios} facts={titleFacts} />
      {#if d.imdbId}<p class="awards" title={ratings?.awards}>
          {ratings?.awards ?? ''}
        </p>{/if}
    </div>
    {#if !guestScout}
      <div class="title-sources" hidden={restricted}>
        <TitleSources
          model={model ?? undefined}
          bind:this={sourcesPanel}
          imdb={ref.type === 'tv' && !sourceCoord ? undefined : d.imdbId}
          {active}
          season={ref.type === 'tv' ? sourceCoord?.season : undefined}
          episode={sourceCoord?.episode}
          title={d.title}
          onplay={onplayhere
            ? (filename) => onplayhere(d.title, sourceCoord?.season, sourceCoord?.episode, filename)
            : undefined}
        />
      </div>
    {/if}
    {#if d.seasons.length && !restricted}
      {@const regular = d.seasons.filter((s) => s.number > 0)}
      <section class="seasons" aria-label="Episodes">
        <p class="totals">
          {regular.length}
          {regular.length === 1 ? 'season' : 'seasons'} · {regular.reduce(
            (sum, s) => sum + s.episodeCount,
            0,
          )} episodes
        </p>
        <div class="section-heading">
          <h2>Episodes</h2>
          {#if series && series.total > 0}<span class="watched-count"
              >{series.watched === series.total
                ? 'All watched'
                : `${series.watched} of ${series.total} watched`}</span
            >{/if}
        </div>
        <div class="season-bar">
          <DetailTabs
            tabs={d.seasons.map((s) => ({ value: String(s.number), label: s.name }))}
            value={String(season)}
            label="Seasons"
            {panel}
            onchange={(value) => (season = Number(value))}
          />
          <!-- Beside the seasons rather than under the episodes: it downloads the season being shown, and at the
             foot of a two-dozen-episode list it was both out of sight and not obviously about this season. -->
          {#if model && scout && !guestScout && d.imdbId && displayedSeason !== null && seasonEpisodes}
            <SeasonDownload
              {model}
              title={d.title}
              imdb={d.imdbId}
              season={displayedSeason}
              episodes={seasonEpisodes}
              disabled={seasonLoading}
              compact
            />
          {/if}
          {#if onseason && seasonMarkable.length}
            <button
              class="season-seen"
              class:on={seasonSeen}
              aria-label={seasonSeen
                ? `Mark season ${displayedSeason} unwatched`
                : `Mark season ${displayedSeason} watched`}
              title={seasonSeen ? 'Mark season unwatched' : 'Mark season watched'}
              aria-disabled={busy || seasonLoading}
              onclick={() => !(busy || seasonLoading) && markSeason(!seasonSeen)}
            >
              <DetailIcon name={seasonSeen ? 'eye' : 'check'} />
            </button>
          {/if}
        </div>
        <div
          id={panel}
          role="tabpanel"
          aria-labelledby={`${panel}-tab-${d.seasons.findIndex((s) => s.number === season)}`}
          aria-busy={seasonLoading}
          class="episode-panel"
        >
          {#if seasonLoading}<div class="season-loading">
              <Loading label="Loading episodes" />
            </div>{/if}
          {#if seasonEpisodes === null && !seasonLoading}<p class="note">
              Couldn’t load this season from TMDB.
            </p>
            <button class="retry" onclick={() => seasonRetry++}>Try again</button>
          {:else if seasonEpisodes}
            <ol
              class="episodes"
              class:loading={seasonLoading}
              inert={seasonLoading}
              aria-hidden={seasonLoading}
            >
              {#each seasonEpisodes as e, index (e.number)}
                {@const episodeDownload =
                  displayedSeason === null
                    ? undefined
                    : downloadLease?.snapshot.value?.items.find(
                        (item) =>
                          item.title.type === d.title.type &&
                          item.title.id === d.title.id &&
                          item.season === displayedSeason &&
                          item.episode === e.number,
                      )}
                {@const episodeDownloadState = episodeDownload
                  ? episodeDownload.status.phase === 'ready'
                    ? 'ready'
                    : episodeDownload.status.phase === 'queued' ||
                        episodeDownload.status.phase === 'downloading'
                      ? 'downloading'
                      : undefined
                  : undefined}
                <EpisodeCard
                  deferred={index >= episodeLimit}
                  episode={e}
                  progress={episodeProgress(episodes.get(`${displayedSeason}:${e.number}`), row)}
                  {busy}
                  fallback={d.backdropPath}
                  onplay={() => playEpisode(e.number)}
                  onseen={(seen) =>
                    displayedSeason !== null && onepisode(d.title, displayedSeason, e.number, seen)}
                  onplaytv={onplay && displayedSeason !== null
                    ? () => onplay(d.title, displayedSeason ?? undefined, e.number)
                    : undefined}
                  onsources={guestScout
                    ? undefined
                    : () => {
                        if (displayedSeason !== null) {
                          sourceTarget = { season: displayedSeason, episode: e.number };
                          void sourcesPanel?.show();
                        }
                      }}
                  ondownload={model && scout && !guestScout && d.imdbId
                    ? () => void queueEpisode(e)
                    : undefined}
                  downloadState={episodeDownloadState}
                />
              {/each}
            </ol>
          {/if}
        </div>
      </section>
    {/if}
    <div class="detail-tail" bind:this={tailRoot}>
      {#if cast.length}
        <div aria-busy={castRemaining ? 'true' : undefined}>
          <PosterRow heading="Cast & Crew">
            {#each cast.slice(0, Math.min(castMounted, castTarget)) as c (c.id)}<PersonCard
                id={c.id}
                name={c.name}
                role={c.role}
                profilePath={c.profilePath}
              />{/each}
            {#if castRemaining}<span
                class="cast-reserve"
                data-cast-placeholder
                style:--remaining={castRemaining}
                aria-hidden="true"
              ></span>{/if}
            <!-- The sentinel also keeps the row's block height identical as its reserve becomes real cards. -->
            <span use:castEnd class="cast-end" aria-hidden="true"></span>
          </PosterRow>
        </div>
      {/if}
      <RelatedTitles
        detail={d}
        {content}
        {atlas}
        studios={iconicStudios}
        facts={titleFacts}
        {active}
        mountRows={relatedMayMount}
        {shown}
      />
    </div>
  {/if}
{/if}

<style>
  .title-sources {
    margin-bottom: 24px;
  }

  .cast-end {
    width: 1px;
    height: calc(var(--card-w) + 66.8px);
  }

  .cast-reserve {
    width: calc(var(--remaining) * var(--card-w) + (var(--remaining) - 1) * 14px);
    height: calc(var(--card-w) + 66.8px);
  }

  .hero {
    position: relative;
    isolation: isolate;
    display: grid;
    align-items: end;
    width: 100vw;

    /* The same height the home billboard takes, so a trailer is the same size wherever you meet it and the
       page below starts where the eye already expects it. It used to stand deliberately taller than the
       window — the actions sat just below the fold — which made the two surfaces disagree by a screenful. */
    --hero-h: var(--stable-hero-height, clamp(420px, 76lvh, 860px));

    /* How far the words sit BELOW the trailer's own box. The block is bottom-aligned, so a negative
       bottom margin moves it down while the picture keeps every pixel of its height. Eight pixels of
       the 48px action remain below the fold: enough to cue the page without manufacturing an empty
       80px action slot and 40px pad between the actions and the next section. Never positive: on a
       window taller than the hero the words would otherwise be pulled up onto the picture. */
    --hero-drop: max(0px, calc(100lvh + 8px - var(--hero-h)));

    min-height: var(--hero-h);
    margin-inline: calc(50% - 50vw);
    margin-top: calc(-1 * var(--bar-space));

    /* The block now hangs past the hero, so the page below starts clear of it rather than under it. */
    margin-bottom: calc(24px + var(--hero-drop));
  }

  /* Past this width a height capped in pixels would letterbox the picture, exactly as it would on the
     billboard, so the hero keeps the same 16:9 floor and the two surfaces stay the same size.

     The variable, not `min-height` directly: `--hero-drop` is measured against it, and a hero that
     was 740 tall while the drop was computed from 598 pushed the words 142px too far. */
  @media (width >= 1000px) {
    .hero {
      --hero-h: max(var(--stable-hero-height, clamp(420px, 76lvh, 860px)), min(56.25vw, 94lvh));
    }
  }

  .visual {
    position: absolute;
    inset: 0;
    background: var(--bg);
  }

  /* The same framing `DetailMedia` gives the real backdrop, and the poster the same blur it gives a
     title without one, so neither shifts, crops nor scales differently when that takes over. */
  .seed-still {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .seed-still.blurred {
    filter: blur(24px);
    transform: scale(1.12);
    opacity: 0.65;
  }

  .still-loading {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
  }

  /* The full-screen button belongs to the video, but the whole hero should offer it. It lives inside the
     media, whose own `:hover` only fires with the pointer over the picture — and the title, facts and
     actions sit in a SIBLING that paints on top of it, so reaching for the words hid the button instead of
     revealing it. Hover applies to what is under the pointer and its ancestors, never to what is merely
     underneath, so the hero has to say this itself. */
  .hero:hover :global(.expand) {
    opacity: 1;
  }

  .hero-content {
    position: relative;
    width: 100%;

    /* The page column, not a wider one of its own: this block holds the title, the facts and the
       actions' notices, and at 1520 its gutter fell outside the page's clip and shaved the first
       characters off every line. */
    max-width: var(--page-max);
    margin: 0 auto calc(-1 * var(--hero-drop));
    padding: calc(var(--bar-space) + 40px) var(--gutter) 0;
  }

  .hero-actions {
    min-height: 48px;
    margin-top: 24px;
  }

  .hero-actions :global(.actions.detail-page) {
    margin-bottom: 0;
  }

  .head {
    display: flex;
    gap: 40px;
    align-items: start;

    /* The hero is bottom-aligned, so this block's height is what the trailer above it does not get. */
    min-height: clamp(200px, 22vw, 300px);
  }

  .copy,
  .loading-copy {
    min-width: 0;
    flex: 1;
  }

  .poster {
    display: block;
    flex: 0 0 clamp(110px, 11vw, 160px);
    width: clamp(110px, 11vw, 160px);
    height: auto;
    aspect-ratio: 2/3;
    object-fit: cover;
    background: var(--card);
    border-radius: 16px;
    box-shadow: 0 12px 32px #0008;
  }

  h1 {
    margin: 0;
    font-size: clamp(28px, 3.4vw, 44px);
    line-height: 1.1;
  }

  .overview {
    max-width: 1000px;
    margin: 24px 0 0;
    line-height: 1.55;
  }

  .awards {
    height: 22px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: 14px;
    margin: 12px 0 0;
  }

  .mobile-overview {
    display: none;
  }

  .continue {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-top: 24px;
    min-height: 52px;
    padding: 4px 0;
    border: 0;
    background: none;
    color: var(--fg);
    text-align: left;
    cursor: pointer;
  }

  .continue small {
    display: block;
    margin-top: 4px;
    color: var(--muted);
  }

  .resume-track {
    display: block;
    width: 240px;
    max-width: 100%;
    height: 4px;
    margin-top: 10px;
    border-radius: 4px;
    background: #fff4;
  }

  .resume-track > span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--fg);
  }

  .continue:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 6px;
    border-radius: 6px;
  }

  .seasons {
    max-width: 1100px;
    margin-bottom: 48px;
  }

  .totals {
    color: var(--muted);
    font-size: 13px;
    margin: 0 0 10px;
  }

  .section-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 20px;
  }

  /* The seasons and their download control on one line, wrapping to two where the tabs need the width.
     The tabs carry their own bottom margin, which in a centred row would sit the icon above the middle of
     the pills — so the spacing below moves here, and the tabs give theirs up inside the bar. */
  .season-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-bottom: 24px;
  }

  .season-bar :global(.tabs) {
    margin-bottom: 0;
  }

  /* The season's watched toggle, beside its download: the same bare mark, so the two read as one set of
     things you can do to this season rather than as a control and a decoration. */
  .season-seen {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 8px;
    border: 0;
    border-radius: 12px;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }

  .season-seen:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }

  .season-seen[aria-disabled='true'] {
    opacity: 0.5;
    cursor: default;
  }

  .season-seen.on {
    color: var(--fg);
  }

  h2 {
    margin: 0;
    font-size: 24px;
  }

  .watched-count {
    color: var(--muted);
    font-size: 14px;
  }

  .episode-panel {
    position: relative;
    min-height: 120px;
  }

  .episodes {
    display: grid;
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .episodes.loading {
    opacity: 0.3;
  }

  .season-loading {
    position: absolute;
    top: 16px;
    inset-inline: 0;
    z-index: 1;
    display: grid;
    justify-content: center;
  }

  .note {
    color: var(--muted);
  }

  .retry {
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 10px 20px;
    background: none;
    color: var(--fg);
    cursor: pointer;
  }

  .placeholder {
    background: var(--card);
    border-radius: 8px;
  }

  .loading-title {
    display: block;
    width: min(100%, 360px);
    height: 2.2em;
    margin-bottom: 12px;
  }

  .loading-facts {
    display: block;
    width: min(85%, 240px);
    height: 2.8em;
  }

  .loading-actions {
    height: 48px;
    max-width: 680px;
  }

  .loading-overview {
    height: 100px;
    max-width: 70ch;
  }

  @media (width <= 759px) {
    .hero {
      /* No drop on a phone: the picture is a 16:9 block with the words under it, covering nothing. */
      --hero-drop: 0px;

      display: block;
      min-height: 0;
      margin-top: 0;
      margin-bottom: 0;
    }

    .visual {
      position: relative;
      inset: auto;
      width: 100%;
      aspect-ratio: 16/9;
    }

    .hero-content {
      padding: 24px var(--gutter) 0;
    }

    /* Reserve the full two-row action footprint only while the title is loading. Loaded actions size
       themselves from their actual rows, so an old worst-case minimum cannot become empty space before
       the overview; the explicit loading slot still keeps the hero steady when detail arrives. */
    .hero-actions.loading-slot {
      min-height: 106px;
    }

    .head {
      gap: 20px;
      align-items: start;
      min-height: clamp(144px, 33vw, 270px);
    }

    .poster {
      flex-basis: clamp(96px, 22vw, 180px);
      width: clamp(96px, 22vw, 180px);
      border-radius: 12px;
    }

    h1 {
      font-size: clamp(24px, 4vw, 32px);
    }

    .desktop-overview {
      display: none;
    }

    .mobile-overview {
      display: block;
      margin: 0 0 24px;
    }

    .overview {
      margin: 12px 0 0;
    }

    .episodes {
      gap: 12px;
    }

    .watched-count {
      font-size: 12px;
    }

    .seasons {
      margin-bottom: 32px;
    }
  }
</style>
