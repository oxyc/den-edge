<script lang="ts">
  import { untrack } from 'svelte';
  import DetailMedia from './DetailMedia.svelte';
  import { stableViewportHeight } from '../lib/stableViewportHeight';
  import type { Routes } from '../lib/routes';
  import Loading from './Loading.svelte';
  import { fetchDetail, fetchSeason, type Episode, type TitleDetail } from '../lib/detail';
  import {
    episodeProgress,
    fetchRatings,
    markableEpisodes,
    productionFacts,
    seriesPresentation,
    type Ratings,
  } from '../lib/detailPresentation';
  import { RESUME_FLOOR, WATCHED } from '../lib/actions';
  import type { MediaType, Title } from '../lib/library';
  import type { EpisodeRow, TitleRow } from '../lib/wire';
  import PersonCard from './PersonCard.svelte';
  import PosterRow from './PosterRow.svelte';
  import TitleActions from './TitleActions.svelte';
  import TitleMetadata from './TitleMetadata.svelte';
  import DetailTabs from './DetailTabs.svelte';
  import EpisodeCard from './EpisodeCard.svelte';
  import SeasonDownload from './SeasonDownload.svelte';
  import DetailIcon from './DetailIcon.svelte';
  import DetailReactions from './DetailReactions.svelte';
  import RelatedTitles from './RelatedTitles.svelte';
  import TitleSources from './TitleSources.svelte';
  import { isBlocked } from '../lib/parental';
  import Trailer from './Trailer.svelte';
  import { sharedInstallOf } from '../lib/grants';
  import { premeasureLink } from '../lib/remux';
  import type { Addon } from '../lib/scout';
  import { navigateBack } from '../lib/navigation';
  import { named } from '../lib/pageTitle';
  import { titleHref } from '../lib/route';

  type Reaction = TitleRow['reaction']['value'];
  let {
    ref,
    active = true,
    reel = null,
    routes = {},
    atlas = null,
    tmdbKey,
    omdbKey = '',
    warningKey = '',
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
  }: {
    ref: { type: MediaType; id: number };
    active?: boolean;
    reel?: string | null;
    routes?: Routes;
    /** Where this page reaches atlas, whose index names the titles closest to this one; null where it can't. */
    atlas?: string | null;
    tmdbKey: string;
    omdbKey?: string;
    warningKey?: string;
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
    /** Where den-remux answers (`findRemux`), so the Sources list can say which releases won't play here. */
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
  } = $props();

  /** The still to stand in with: the backdrop it will end up using, or the poster as a last resort. */
  const seedStill = $derived(
    seed?.backdropPath
      ? `https://image.tmdb.org/t/p/w1280${seed.backdropPath}`
      : seed?.posterPath
        ? `https://image.tmdb.org/t/p/w780${seed.posterPath}`
        : null,
  );
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
  // Away from home a play asks den-remux for a session that fits the link. Timing it while this page is read lets the
  // first play's request carry it, rather than start a session only to measure and start another. Given up on when
  // the page stops being the active one — which pressing Play does.
  $effect(() => {
    if (!active || !onplayhere || !remux) return;
    return premeasureLink(remux);
  });
  let sourcesPanel = $state<TitleSources>();
  let sourceTarget = $state<{ season: number; episode: number } | undefined>();
  let detail = $state<TitleDetail | null | undefined>();
  /** The cast row shows the top of the bill and goes on as it is scrolled to its end: a long series lists hundreds. */
  const CAST_PAGE = 20;
  let castShown = $state(CAST_PAGE);
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
  let season = $state<number | null>(null);
  let seasonEpisodes = $state<Episode[] | null | undefined>();
  let displayedSeason = $state<number | null>(null);
  let seasonLoading = $state(false);
  let retry = $state(0),
    seasonRetry = $state(0);
  let ratings = $state<Ratings | null>(null);
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Promise memoization must not become a dependency of the season-loading effect.
  const seasonCache = new Map<string, Promise<Episode[] | null>>();

  $effect(() => {
    const [current, key, country] = [ref, tmdbKey, region];
    void retry;
    let live = true;
    detail = undefined;
    season = null;
    seasonEpisodes = undefined;
    displayedSeason = null;
    castShown = CAST_PAGE;
    void fetchDetail(current, key, undefined, country).then((loaded) => {
      if (!live) return;
      detail = loaded;
      season = loaded ? seriesPresentation(loaded, episodes, row).initialSeason : null;
    });
    return () => {
      live = false;
    };
  });

  $effect(() => {
    const [picked, current, key] = [season, ref, tmdbKey];
    void seasonRetry;
    if (picked === null || current.type !== 'tv') return;
    let live = true;
    seasonLoading = true;
    const cacheKey = `${current.id}:${picked}:${key}`;
    let request = seasonCache.get(cacheKey);
    if (!request) {
      request = fetchSeason(current.id, picked, key);
      seasonCache.set(cacheKey, request);
      void request.then((result) => {
        if (result === null) seasonCache.delete(cacheKey);
      });
    }
    void request.then((loaded) => {
      if (!live) return;
      seasonEpisodes = loaded;
      displayedSeason = picked;
      seasonLoading = false;
    });
    return () => {
      live = false;
    };
  });

  $effect(() => {
    const [id, key] = [detail?.imdbId, omdbKey];
    ratings = null;
    if (!id) return;
    const controller = new AbortController();
    void fetchRatings(id, key, controller.signal).then((loaded) => {
      if (!controller.signal.aborted) ratings = loaded;
    });
    return () => controller.abort();
  });

  // The page names itself once TMDB has answered. Until then the tab reads "Den", which is all the address
  // can say: a bookmark or a second tab full of titles is otherwise twenty pages with the same name.
  $effect(() => {
    if (detail?.title.title) document.title = named(detail.title.title, detail.title.year);
  });

  const series = $derived(detail ? seriesPresentation(detail, episodes, row) : null);
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
  const cast = $derived(
    detail
      ? [...detail.directors, ...detail.cast].filter(
          (c, i, all) => all.findIndex((other) => other.id === c.id) === i,
        )
      : [],
  );
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
</script>

{#if detail === undefined}
  <div aria-busy="true" aria-label="Loading title">
    <!-- A spinner only where there is nothing to look at. Over the title's own picture it is just
         furniture on the thing the viewer came for. -->
    {#if !seedStill}<Loading label="Loading title" page />{/if}
    <header class="hero" aria-hidden="true" use:stableViewportHeight>
      <div class="visual">
        {#if seedStill}
          <img class="seed-still" class:portrait={!seed?.backdropPath} src={seedStill} alt="" />
        {/if}
      </div>
      <div class="hero-content">
        <div class="head">
          {#if seed?.posterPath}
            <img
              class="poster"
              src="https://image.tmdb.org/t/p/w500{seed.posterPath}"
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
        <div class="hero-actions"><div class="loading-actions placeholder"></div></div>
      </div>
    </header>
    <div class="loading-overview placeholder" aria-hidden="true"></div>
  </div>
{:else if detail === null}
  <p class="note">Couldn’t load this title from TMDB.</p>
  <button class="retry" onclick={() => retry++}>Try again</button>
{:else}
  {@const d = detail}
  <header class="hero" use:stableViewportHeight>
    <div class="visual">
      <DetailMedia
        autoplay={autoplay && !restricted}
        type={ref.type}
        tmdbId={ref.id}
        imdbId={d.imdbId}
        {active}
        {reel}
        {routes}
        backdrop={d.backdropPath ? `https://image.tmdb.org/t/p/w1280${d.backdropPath}` : undefined}
        poster={d.title.posterPath
          ? `https://image.tmdb.org/t/p/w780${d.title.posterPath}`
          : undefined}
      />
    </div>
    <div class="hero-content">
      <div class="head">
        {#if d.title.posterPath}<img
            class="poster"
            src="https://image.tmdb.org/t/p/w500{d.title.posterPath}"
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
            {warningKey}
            {warningCategories}
          />
          {#if d.overview}<p class="overview desktop-overview">{d.overview}</p>{/if}
          {#if productionFacts(d)}<p class="production desktop-overview">
              {productionFacts(d)}
            </p>{/if}
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
  </header>
  {#if trailerOpen && d.trailer}
    <Trailer key={d.trailer} title={d.title.title} onclose={() => (trailerOpen = false)} />
  {/if}
  <div class="mobile-overview">
    {#if d.overview}<p class="overview">{d.overview}</p>{/if}
    {#if productionFacts(d)}<p class="production">{productionFacts(d)}</p>{/if}
    {#if d.imdbId}<p class="awards" title={ratings?.awards}>
        {ratings?.awards ?? ''}
      </p>{/if}
  </div>
  {#if !guestScout}
    <div class="title-sources" hidden={restricted}>
      <TitleSources
        bind:this={sourcesPanel}
        imdb={ref.type === 'tv' && !sourceCoord ? undefined : d.imdbId}
        {scout}
        {routes}
        {active}
        {remux}
        season={ref.type === 'tv' ? sourceCoord?.season : undefined}
        episode={sourceCoord?.episode}
        onplay={onplayhere
          ? (filename) => onplayhere(d.title, sourceCoord?.season, sourceCoord?.episode, filename)
          : undefined}
      />
    </div>
  {/if}
  <DetailReactions
    value={row && !row.deleted.value ? row.reaction.value : null}
    {busy}
    onchange={(value) => onreact(d.title, value)}
  />

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
        {#if scout && !guestScout && d.imdbId && displayedSeason !== null && seasonEpisodes}
          <SeasonDownload
            {scout}
            imdb={d.imdbId}
            season={displayedSeason}
            episodes={seasonEpisodes}
            {routes}
            disabled={seasonLoading}
            compact
          />
        {/if}
        {#if onseason && seasonMarkable.length}
          <button
            class="season-seen"
            aria-pressed={seasonSeen}
            aria-label={seasonSeen
              ? `Mark season ${displayedSeason} unwatched`
              : `Mark season ${displayedSeason} watched`}
            title={seasonSeen ? 'Mark season unwatched' : 'Mark season watched'}
            disabled={busy || seasonLoading}
            onclick={() => markSeason(!seasonSeen)}
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
            {#each seasonEpisodes as e (e.number)}
              <EpisodeCard
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
              />
            {/each}
          </ol>
        {/if}
      </div>
    </section>
  {/if}
  {#if cast.length}
    <PosterRow heading="Cast & Crew">
      {#each cast.slice(0, castShown) as c (c.id)}<PersonCard
          id={c.id}
          name={c.name}
          role={c.role}
          profilePath={c.profilePath}
        />{/each}
      <span use:castEnd class="cast-end" aria-hidden="true"></span>
    </PosterRow>
  {/if}
  <RelatedTitles detail={d} {tmdbKey} {atlas} {active} {shown} />
{/if}

<style>
  .title-sources {
    margin-bottom: 24px;
  }

  .cast-end {
    width: 1px;
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

    /* How far the words sit BELOW the trailer's own box.
       The block is bottom-aligned, so a negative bottom margin is what moves it down while the
       picture keeps every pixel of its height. Enough of one to put the actions across the fold —
       40px of bottom padding plus half the 80px row — so half a play button shows and the rest is
       the cue that there is a page under it. Never positive: on a window taller than the hero the
       words would be pulled up onto the picture instead. */
    --hero-drop: max(0px, calc(100lvh + 80px - var(--hero-h)));

    min-height: var(--hero-h);
    margin-inline: calc(50% - 50vw);
    margin-top: calc(-1 * var(--bar-space));

    /* The block now hangs past the hero, so the page below starts clear of it rather than under it. */
    margin-bottom: calc(32px + var(--hero-drop));
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

  /* The same framing `DetailMedia` gives the real backdrop, so the picture does not shift when the
     one takes over from the other. A poster standing in for a missing backdrop is portrait, and is
     held to the top rather than centre-cropped through the middle of a face. */
  .seed-still {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .seed-still.portrait {
    object-position: center top;
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
    padding: calc(var(--bar-space) + 40px) var(--gutter) 40px;
  }

  .hero-actions {
    min-height: 80px;
    margin-top: 24px;
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

  .production {
    color: var(--muted);
    font-size: 14px;
    margin: 20px 0 0;
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

  .season-seen:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .season-seen[aria-pressed='true'] {
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

    .hero-actions {
      min-height: 122px;
    }

    .head {
      gap: 20px;
      align-items: end;
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
      margin: 0 0 32px;
    }

    .overview {
      margin: 12px 0 0;
    }

    .production {
      margin-top: 16px;
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
