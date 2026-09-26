<script lang="ts">
  import ContentWarnings from './ContentWarnings.svelte';
  import type { TitleDetail } from '../lib/detail';
  import { titleFacts, type Ratings } from '../lib/detailPresentation';
  import { searchHref, serviceHref } from '../lib/route';
  let {
    detail: d,
    ratings = null,
    enabled = ['imdb', 'tmdb', 'rottenTomatoes', 'metacritic'],
    pending = false,
    warningKey = '',
    warningCategories = [],
    region = 'US',
  }: {
    detail: TitleDetail;
    ratings?: Ratings | null;
    enabled?: string[];
    pending?: boolean;
    warningKey?: string;
    warningCategories?: string[];
    region?: string;
  } = $props();
  const imdb = $derived(enabled.includes('imdb') ? ratings?.imdb : undefined);
  const tmdb = $derived(
    enabled.includes('tmdb') && (d.title.votes ?? 0) > 0 ? d.title.rating : undefined,
  );
  const primary = $derived(imdb ?? tmdb);
  const votes = $derived(imdb !== undefined ? ratings?.votes : d.title.votes);
  // Where a score can be read in full. Only these two can be pointed at: OMDb answers for Rotten Tomatoes and
  // Metacritic with a number and nothing else — no id, no slug — and a guessed URL is worse than none.
  // An IMDb score exists only because OMDb was asked for it by that id, so the link is there whenever it is.
  const imdbHref = $derived(d.imdbId ? `https://www.imdb.com/title/${d.imdbId}/` : undefined);
  const tmdbHref = $derived(`https://www.themoviedb.org/${d.title.type}/${d.title.id}`);
  const primaryHref = $derived(imdb !== undefined ? imdbHref : tmdbHref);
  const compact = (n: number) =>
    new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  const facts = $derived(titleFacts(d));
  const factHref = (fact: string, index: number) => {
    if (index === 0 && d.title.year && /^\d{4}/.test(fact))
      return searchHref('', { chips: [`decade-${Math.floor(d.title.year / 10) * 10}`] });
    if (index === facts.length - 1)
      return searchHref('', { type: d.title.type === 'tv' ? 'tv' : 'movie' });
  };
</script>

{#if primary !== undefined || pending || (ratings && enabled.length)}
  <div class="ratings" class:expanded={pending} aria-label="Ratings">
    {#if primary !== undefined}
      <a
        class="primary"
        href={primaryHref}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${imdb !== undefined ? 'IMDb' : 'TMDB'} rating ${primary.toFixed(1)}`}
        ><span class="star" aria-hidden="true">★</span><b>{primary.toFixed(1)}</b><span
          class="source">{imdb !== undefined ? 'IMDb' : 'TMDB'}</span
        >{#if votes}<span class="votes">({compact(votes)})</span>{/if}</a
      >
    {/if}
    {#if imdb !== undefined && tmdb !== undefined}<a
        href={tmdbHref}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`TMDB rating ${tmdb.toFixed(1)}`}
        ><b>{tmdb.toFixed(1)}</b><span class="source">TMDB</span></a
      >{/if}
    {#if enabled.includes('rottenTomatoes') && ratings?.rottenTomatoes !== undefined}<span
        aria-label={`Rotten Tomatoes ${ratings.rottenTomatoes}%`}
        ><b>{ratings.rottenTomatoes}%</b><span class="source">RT</span></span
      >{/if}
    {#if enabled.includes('metacritic') && ratings?.metacritic !== undefined}<span
        aria-label={`Metacritic ${ratings.metacritic} out of 100`}
        ><b>{ratings.metacritic}</b><span class="source">MC</span></span
      >{/if}
  </div>
{/if}
<div class="facts">
  {#each facts as fact, i (`${i}:${fact}`)}{#if i}<span aria-hidden="true">·</span
      >{/if}{#if factHref(fact, i)}<a class="filter-link" href={factHref(fact, i)}>{fact}</a
      >{:else}<span>{fact}</span>{/if}{/each}
  {#if d.certification}<span class="chip">{d.certification}</span>{/if}
  <ContentWarnings detail={d} apiKey={warningKey} categories={warningCategories} />
  {#if d.providers.length}
    <span
      class="providers"
      aria-label={`Streaming on ${d.providers.map((p) => p.name).join(', ')}`}
    >
      {#each d.providers as provider (provider.id)}
        <a
          class="provider"
          href={serviceHref(provider.id, region, provider.name)}
          aria-label={`Browse ${provider.name}`}
          title={`Browse ${provider.name}`}
          >{#if provider.logoPath}<img
              src={`https://image.tmdb.org/t/p/w92${provider.logoPath}`}
              alt=""
              width="26"
              height="26"
            />{:else}{provider.name}{/if}</a
        >
      {/each}<a
        class="attribution"
        href={d.watchLink ?? 'https://www.justwatch.com/'}
        target="_blank"
        rel="noopener noreferrer">JustWatch</a
      >
    </span>
  {/if}
</div>
{#if d.genres.length}<p class="genres">
    {#each d.genres as genre, i (genre.id)}{#if i}<span aria-hidden="true"> · </span>{/if}<a
        class="filter-link"
        href={searchHref('', {
          type: d.title.type === 'tv' ? 'tv' : 'movie',
          chips: [`genre-${genre.id}`],
        })}>{genre.name}</a
      >{/each}
  </p>{/if}

<style>
  .filter-link,
  .attribution {
    color: inherit;
    text-decoration-color: transparent;
    text-underline-offset: 3px;
  }

  .attribution {
    font-size: 10px;
  }

  .filter-link:hover,
  .filter-link:focus-visible,
  .attribution:hover,
  .attribution:focus-visible {
    color: var(--fg);
    text-decoration-color: currentcolor;
  }

  .ratings {
    display: flex;
    align-items: baseline;
    align-content: start;
    gap: 18px;
    min-height: 32px;
    margin: 14px 0 4px;
    white-space: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .ratings > span,
  .ratings > a {
    display: inline-flex;
    align-items: baseline;
    gap: 5px;
  }

  .ratings > a {
    color: inherit;
    text-decoration: none;
  }

  .ratings > a:hover,
  .ratings > a:focus-visible {
    text-decoration: underline;
  }

  .ratings b {
    font-variant-numeric: tabular-nums;
  }

  .primary b {
    font-size: 20px;
  }

  .star {
    color: #ffd35c;
  }

  .source,
  .votes {
    color: var(--muted);
    font-size: 12px;
  }

  .facts {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 10px;
    margin: 12px 0 0;
    color: var(--muted);
  }

  .genres {
    color: var(--muted);
    margin: 12px 0 0;
  }

  .providers {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    color: var(--muted);
    text-decoration: none;
  }

  .provider {
    display: inline-flex;
    align-items: center;
    color: inherit;
    text-decoration: none;
  }

  .providers img {
    width: 26px;
    height: 26px;
    border-radius: 6px;
  }

  @media (width <= 759px) {
    .ratings {
      flex-wrap: wrap;
      gap: 4px 12px;
      margin-top: 10px;
      white-space: normal;
      overflow: visible;
    }

    .ratings.expanded {
      min-height: 60px;
    }

    .facts,
    .genres {
      font-size: 13px;
      margin-top: 8px;
      gap: 4px 6px;
    }
  }

  @media (width <= 359px) {
    .ratings.expanded {
      min-height: 88px;
    }
  }
</style>
