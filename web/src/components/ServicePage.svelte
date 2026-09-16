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
  import { fetchServices, matches, type Service } from '../settings/services';
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
    const tmdb = serviceRows(service, country, tmdbPages(tmdbKey), { minYear, only });
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

  // The tab, the bookmark and the history entry name the service once the directory has named it; until then the
  // route's own "Service · Den" stands (`pageTitle`).
  $effect(() => {
    if (service) document.title = named(service.name);
  });
</script>

{#if service}
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
  .brand {
    display: flex;
    align-items: center;
    gap: 14px;
    margin: 0 0 20px;
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

  .tabs {
    display: flex;
    margin: 0 0 20px;
  }

  .note {
    color: var(--muted);
  }
</style>
