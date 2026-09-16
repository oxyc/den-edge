<!-- One service's catalogue in one country (the TV's ServiceChannelView): the brand, then what it carries — popular,
     recently released and acclaimed, films and series alternating.

     Nothing is capped. Each row pages on as it is scrolled, and a row that comes back empty hides itself, so the page
     ends up exactly as deep as the service is rather than promising a catalogue it doesn't have. -->
<script lang="ts">
  import { tmdbPages } from '../lib/catalog';
  import type { MediaType, Title } from '../lib/library';
  import { named } from '../lib/pageTitle';
  import {
    atlasCatalogs,
    atlasServiceRows,
    mergeServiceRows,
    serviceRows,
    type AtlasCatalog,
  } from '../lib/services';
  import type { Routes } from '../lib/routes';
  import { fetchServices, matches, type Service } from '../settings/services';
  import Billboard from './Billboard.svelte';
  import Browse from './Browse.svelte';
  import JustWatchCredit from './JustWatchCredit.svelte';
  import Loading from './Loading.svelte';
  import TypeFilter from './TypeFilter.svelte';

  let {
    id,
    country,
    tmdbKey,
    atlas = null,
    minYear,
    excludedLanguages = new Set<string>(),
    reel = null,
    routes = {},
    shown,
  }: {
    /** The provider id, as TMDB and atlas both name it. */
    id: number;
    /** ISO-3166 alpha-2: which country's catalogue this page is. */
    country: string;
    tmdbKey: string;
    /** Where atlas answers, when this page can reach it: its charts are what TMDB cannot say. */
    atlas?: string | null;
    /** Settings' release-year floor, applied to every row here as it is everywhere else. */
    minYear?: number;
    /** Settings' excluded languages: a row about nothing else is not offered here either. */
    excludedLanguages?: Set<string>;
    /** Where this page reaches den-reel, for the hero's trailer; without it the hero keeps its still. */
    reel?: string | null;
    /** The routes table, for the address the trailer's video loads from. */
    routes?: Routes;
    shown: (title: Title) => boolean;
  } = $props();

  let directory = $state<Service[] | null>(null);
  let unreachable = $state(false);

  $effect(() => {
    const wanted = country;
    let current = true;
    directory = null;
    unreachable = false;
    answered = [];
    void fetchServices(wanted, tmdbKey).then(
      (services) => {
        if (current) directory = services;
      },
      () => {
        if (current) unreachable = true;
      },
    );
    return () => {
      current = false;
    };
  });

  /** A pick can name a variant TMDB has since demoted, so the directory is searched by fold, not by id. */
  const service = $derived(directory?.find((entry) => matches(entry, id)) ?? null);
  /** Which of a service's catalogue is shown; null is all of it. Offered only where the service carries both. */
  let tab = $state<MediaType | null>(null);
  const both = $derived(!!service?.movies && !!service.series);
  /** atlas's catalogs, when it answers. Its rows are left out rather than waited for: TMDB's stand on their own. */
  let catalogs = $state<AtlasCatalog[]>([]);
  $effect(() => {
    const here = atlas;
    if (!here) return;
    let current = true;
    void atlasCatalogs(here).then(
      (listed) => {
        if (current) catalogs = listed;
      },
      () => {
        // atlas down or not reachable from here: the page is TMDB's rows, which is what it was before atlas had any.
      },
    );
    return () => {
      current = false;
    };
  });

  /**
   * The media types atlas has answered with titles for. A chart that is listed and comes back empty hides itself, so
   * replacing TMDB's rows on the strength of the listing alone left a page of nothing but Acclaimed.
   */
  let answered = $state<MediaType[]>([]);
  const only = $derived(tab ?? undefined);
  const rows = $derived.by(() => {
    if (!service) return [];
    const tmdb = serviceRows(service, country, tmdbPages(tmdbKey), {
      minYear,
      only,
      excludedLanguages,
    });
    const own = atlas ? atlasServiceRows(atlas, catalogs, service, country, { only, tmdbKey }) : [];
    const watched = own.map((row) => ({
      ...row,
      load: async (page: number) => {
        const titles = await row.load(page);
        if (titles.length && !answered.includes(row.type)) answered = [...answered, row.type];
        return titles;
      },
    }));
    return mergeServiceRows(watched, tmdb, new Set(answered));
  });

  /**
   * The page's own hero, as the TV's channel page opens with one rather than with a list (`ServiceChannelView`):
   * the head of this page's leading row — what has just arrived on the service where atlas says so, and its most
   * popular titles where it doesn't.
   *
   * It asks for that row itself instead of waiting to share it. The question is identical, so the row below is
   * answered from this browser's own TMDB cache rather than from the network, and neither waits on the other.
   */
  let featured = $state<Title[]>([]);
  /** As many as are worth cycling; the TV's hero carries forty, and a service's lead row is shorter than that. */
  const SLIDES = 12;
  /** Which row the hero was built from, so a re-derived `rows` doesn't fetch it again. */
  let heroFrom = '';
  $effect(() => {
    const lead = rows[0];
    if (!lead || lead.id === heroFrom) return;
    heroFrom = lead.id;
    const forRow = lead.id;
    void lead.load(1).then(
      (titles) => {
        // Stale only if a DIFFERENT row has since taken the lead. This must not be a cleanup that cancels on
        // re-run: `rows` re-derives the moment atlas's catalogs answer, and the cancel threw away the load in
        // flight while the re-run saw the same row and returned early — so the hero appeared only when a warm
        // cache let the load finish first, which is why a refresh showed it and a fresh visit did not.
        if (forRow === heroFrom) featured = titles.filter(shown).slice(0, SLIDES);
      },
      () => {
        // No hero, then — the page is its rows, which is what it was before it had one.
      },
    );
  });

  // The tab, the bookmark and the history entry name the service once the directory has named it; until then the
  // route's own "Service · Den" stands (`pageTitle`).
  $effect(() => {
    if (service) document.title = named(service.name);
  });
</script>

{#if service}
  <!-- The brand rides ON the hero, top left, as the TV's channel page does (`ServiceChannelView`: a ZStack
       aligned `.topLeading`, lockup padded in from the edge) — so the page opens AS this service rather than as
       a label glued above somebody else's artwork. The hero is full-bleed and pulls itself up behind the
       navigation bar, which is why the lockup is positioned within this wrapper rather than placed before it.
       Narrower than the desktop breakpoint it returns to the flow, where a lockup over a short picture crowds
       the title it happens to be sitting on. -->
  <div class="hero" class:branded={featured.length > 0}>
    {#if featured.length}
      <Billboard titles={featured} {tmdbKey} {reel} {routes} />
    {/if}
    <header class="brand">
      {#if service.logoPath}
        <img
          class="logo"
          src={`https://image.tmdb.org/t/p/w154${service.logoPath}`}
          alt=""
          width="64"
          height="64"
        />
      {/if}
      <h1>{service.name}</h1>
    </header>
  </div>
  <JustWatchCredit />
  {#if both}
    <div class="tabs">
      <TypeFilter value={tab} onchange={(value) => (tab = value)} label="Show on this service" />
    </div>
  {/if}
  <Browse {rows} {shown} />
{:else if unreachable}
  <p class="note">Couldn’t reach the service directory. Check your connection and try again.</p>
{:else if directory}
  <p class="note">This service isn’t listed in {country}.</p>
{:else}
  <div data-route-loading><Loading label="Loading this service" page /></div>
{/if}

<style>
  .hero {
    position: relative;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 14px;
    margin: 0 0 20px;
  }

  /* On the picture rather than above it, at every width: the page opens as this service, and the rows keep the
     line the lockup would otherwise take. */
  .branded .brand {
    position: absolute;

    /* Measured from this wrapper, whose own top edge is pulled up with the billboard's negative margin — they
       collapse — so it sits behind the navigation bar unless the bar's height is added back. */
    top: calc(var(--bar-space) + 16px);
    left: 0;
    z-index: 2;
    margin: 0;

    /* A label, not a control: the slide beneath it stays pressable through the lockup. */
    pointer-events: none;
    text-shadow: 0 2px 14px rgb(0 0 0 / 0.65);
  }

  @media (width >= 760px) {
    .branded .brand {
      top: calc(var(--bar-space) + 24px);
    }
  }

  .logo {
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--card);
  }

  h1 {
    margin: 0;
    font-size: 28px;
  }

  /* On a phone the lockup sits in the flow rather than on the picture, so it can be smaller: it is naming the
     page, not competing with the artwork above it. */
  @media (width <= 759px) {
    .logo {
      width: 44px;
      height: 44px;
      border-radius: 10px;
    }

    h1 {
      font-size: 22px;
    }

    /* The mark alone on a phone — a service's logo is the thing people recognise, and the name would take a
       third of the width of the picture to repeat it. Hidden from the eye only: the heading still names the
       page for a screen reader and for the document outline. Where there is no logo the name is all there is,
       so this applies only when one precedes it. */
    .branded .logo + h1 {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }

    /* Three margins stack between the picture and the first row — the hero's own, the credit's and the tabs' —
       which on a phone is most of a thumb's worth of nothing. Tightened here rather than at each component:
       the hero's spacing is Home's too, and the credit says in as many words that the surface owns its own. */
    .hero :global(.billboard) {
      margin-bottom: 14px;
    }

    .hero + :global(.credit) {
      margin-bottom: 12px;
    }

    .tabs {
      margin-bottom: 14px;
    }
  }

  .tabs {
    display: flex;
    margin: 0 0 20px;
  }

  .note {
    color: var(--muted);
  }
</style>
