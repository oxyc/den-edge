<!-- One service's catalogue in one country (the TV's ServiceChannelView): the brand, then what it carries — popular,
     recently released and acclaimed, films and series alternating.

     Nothing is capped. Each row pages on as it is scrolled, and a row that comes back empty hides itself, so the page
     ends up exactly as deep as the service is rather than promising a catalogue it doesn't have. -->
<script lang="ts">
  import { tmdbPages } from '../lib/catalog';
  import type { Title } from '../lib/library';
  import { named } from '../lib/pageTitle';
  import { serviceRows } from '../lib/services';
  import { fetchServices, matches, type Service } from '../settings/services';
  import Browse from './Browse.svelte';
  import JustWatchCredit from './JustWatchCredit.svelte';
  import Loading from './Loading.svelte';

  let {
    id,
    country,
    tmdbKey,
    minYear,
    shown,
  }: {
    /** The provider id, as TMDB and atlas both name it. */
    id: number;
    /** ISO-3166 alpha-2: which country's catalogue this page is. */
    country: string;
    tmdbKey: string;
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
  /** Which of a service's catalogue is shown. Offered only where the service carries both. */
  let tab = $state<'all' | 'movie' | 'tv'>('all');
  const both = $derived(!!service?.movies && !!service.series);
  const rows = $derived(
    service
      ? serviceRows(service, country, tmdbPages(tmdbKey), {
          minYear,
          only: tab === 'all' ? undefined : tab,
        })
      : [],
  );

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
    <div class="tabs" role="group" aria-label="What to show">
      {#each [['all', 'All'], ['movie', 'Movies'], ['tv', 'Series']] as const as [value, label] (value)}
        <button
          type="button"
          class:on={tab === value}
          aria-pressed={tab === value}
          onclick={() => (tab = value)}>{label}</button
        >
      {/each}
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
    gap: 8px;
    margin: 0 0 20px;
  }

  .tabs button {
    padding: 6px 14px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 14px;
    cursor: pointer;
  }

  .tabs button.on {
    border-color: transparent;
    background: var(--fg);
    color: var(--bg);
  }

  .note {
    color: var(--muted);
  }
</style>
