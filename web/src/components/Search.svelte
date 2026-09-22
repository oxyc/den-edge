<!-- Search, browse-first (the TV's Explore, oxyc/den#69). Before anything is typed: Movies or Series, one chip open —
     For You, a genre, a recipe or a mood — and the endless grid it fills. Typing searches instead, and clearing the
     query returns to the chip that was open, since the address still names it. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import ExploreChips from './ExploreChips.svelte';
  import Loading from './Loading.svelte';
  import SearchResults from './SearchResults.svelte';
  import TypeFilter from './TypeFilter.svelte';
  import { tmdbPages } from '../lib/catalog';
  import { exploreChips, exploreFeed, FOR_YOU, openChip, PROMPTS, remapChip } from '../lib/explore';
  import type { MediaType, Title } from '../lib/library';
  import { navigate } from '../lib/navigation';
  import { Pager } from '../lib/pager.svelte';
  import { isHidden, type Prefs } from '../lib/prefs';
  import { searchHref, type Explore } from '../lib/route';
  import { searchStream, type Hit } from '../lib/search';
  import { searchSources } from '../lib/searchSources';

  let {
    query,
    explore = {},
    tmdbKey,
    atlas,
    prefs,
    shown = () => true,
    seeds = [],
    owned = new Set(),
  }: {
    query: string;
    /** What Explore is browsing, from the address. */
    explore?: Explore;
    tmdbKey: string;
    atlas: string | null;
    prefs: Prefs;
    /** What the browse rows hide — the grid is one of them. Typed results keep their own, looser rule. */
    shown?: (title: Title) => boolean;
    /** The library's latest titles, For You's seeds. */
    seeds?: Title[];
    /** Every title the library holds, by `type:id`. */
    owned?: ReadonlySet<string>;
  } = $props();

  const sources = $derived(searchSources(tmdbKey, undefined, atlas));
  const rulesKey = $derived(
    JSON.stringify([
      [...prefs.excludedGenres].sort(),
      [...prefs.excludedLanguages].sort(),
      prefs.hideAnime,
    ]),
  );
  const typing = $derived(query.trim().length >= 2);

  // Explore browses one type at a time, Movies until another is chosen. Typed results show every type until one is.
  const exploreType = $derived<MediaType>(explore.type ?? 'movie');
  const chipsFor = (type: MediaType) =>
    exploreChips(type, { hiddenGenres: prefs.excludedGenres, atlas: atlas !== null });
  const chips = $derived(chipsFor(exploreType));
  const chip = $derived(openChip(explore.chip, chips));

  /** Each chip and type is somewhere a person went, so each gets its own history entry. */
  function go(next: Explore, text = query) {
    navigate(
      searchHref(text, {
        type: next.type,
        chip: next.chip === FOR_YOU ? undefined : next.chip,
      }),
    );
  }

  /** A genre open under one type stays open as its closest counterpart under the other (SearchModel.setScope). */
  function chooseType(type: MediaType | null) {
    const to = type ?? 'movie';
    go({ type: type ?? undefined, chip: remapChip(chip.id, exploreType, to, chipsFor(to)) });
  }

  // The open chip's feed. Only the chip, and what reaches TMDB and atlas, start it again: a new seed or a write
  // elsewhere must not empty a grid someone is scrolling. It waits while a query is typed, and is still where it
  // was once the query is cleared.
  const feed = $derived.by(() => {
    const row = exploreFeed(chip, exploreType, {
      pages: tmdbPages(tmdbKey),
      atlas,
      seeds: untrack(() => seeds),
      owned: untrack(() => owned),
      minYear: prefs.minReleaseYear,
    });
    const admitted = (title: Title) => shown(title) && (row.filter?.(title) ?? true);
    return { pager: new Pager(row.load, admitted), admitted };
  });
  const feedHits = $derived(
    feed.pager.titles.filter(feed.admitted).map((title): Hit => ({ kind: 'title', title })),
  );
  $effect(() => {
    if (!typing && feed.pager.page === 0) void feed.pager.more();
  });

  // A new chip starts at the top of the page, as a new page would.
  let lastFeed = untrack(() => feed);
  $effect(() => {
    if (feed === lastFeed) return;
    lastFeed = feed;
    window.scrollTo({ top: 0, behavior: 'instant' });
  });

  let hits = $state<Hit[] | null>(null);
  let failed = $state(false);
  let pending = $state(false);

  $effect(() => {
    const text = query.trim();
    const available = sources;
    void rulesKey;
    const rules = untrack(() => prefs);
    let current = true;
    failed = false;
    if (text.length < 2) {
      hits = null;
      pending = false;
      return;
    }
    // The last results stay while the next load: tearing the grid down for a spinner on every letter is what
    // made typing feel slow. The spinner is only for a search with nothing on screen yet.
    pending = true;
    const timer = setTimeout(async () => {
      let answered = false;
      try {
        for await (const batch of searchStream(text, available)) {
          if (!current) return;
          answered = true;
          hits = batch.filter(
            (hit) =>
              hit.kind === 'person' || !isHidden(hit.title, rules, { ignoringYearFloor: true }),
          );
          pending = false;
        }
        if (current && !answered) hits = [];
      } catch {
        if (current) {
          failed = true;
          hits = [];
        }
      } finally {
        if (current) pending = false;
      }
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  });

  /** Typed results of the chosen type; people only under All, as on the TV. */
  const typedHits = $derived(
    (hits ?? []).filter(
      (hit) =>
        explore.type === undefined || (hit.kind === 'title' && hit.title.type === explore.type),
    ),
  );
</script>

<section
  class="search"
  aria-label={typing ? 'Search results' : 'Explore'}
  aria-busy={typing ? pending : feed.pager.page === 0 && !feed.pager.done}
>
  <h1>{typing ? 'Search' : 'Explore'}</h1>
  {#if typing}
    <div class="controls">
      <TypeFilter
        value={explore.type ?? null}
        onchange={(type) => go({ type: type ?? undefined, chip: chip.id })}
        label="Show in search results"
      />
    </div>
    {#if hits === null}
      <Loading label="Searching" />
    {:else if typedHits.length}
      <div class:stale={pending}><SearchResults hits={typedHits} /></div>
    {:else if !pending}
      <p class="note" role="status">
        {failed ? 'Couldn’t search right now. Try again in a moment.' : 'No matches.'}
      </p>
    {/if}
  {:else}
    <div class="explore">
      <div class="rail">
        <TypeFilter
          value={exploreType}
          onchange={chooseType}
          label="Browse movies or series"
          all={false}
        />
        <ExploreChips
          {chips}
          value={chip.id}
          onchange={(id) => go({ type: explore.type, chip: id })}
        />
      </div>
      <div class="feed">
        {#if chip.id === FOR_YOU}
          <div class="prompts" role="group" aria-label="Try describing it">
            <span class="try">Try describing it</span>
            {#each PROMPTS as prompt (prompt)}
              <button
                type="button"
                onclick={() => go({ type: explore.type, chip: chip.id }, prompt)}>“{prompt}”</button
              >
            {/each}
          </div>
        {/if}
        {#if feedHits.length}
          <SearchResults hits={feedHits} onend={() => void feed.pager.more()} />
        {:else if feed.pager.done}
          <p class="note" role="status">Nothing here yet. Try another category.</p>
        {:else}
          <Loading label="Loading {chip.label}" />
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  h1 {
    font-size: 28px;
    margin: 8px 0 16px;
  }

  .controls {
    display: flex;
    margin: 0 0 20px;
  }

  .note {
    color: var(--muted);
  }

  /* The last results, while the next ones load. */
  .stale {
    opacity: 0.6;
    transition: opacity 120ms;
  }

  /* A phone and a tablet: the type and the chips over the grid, held under the bar as the grid scrolls. */
  .rail {
    position: sticky;
    top: calc(max(12px, env(safe-area-inset-top)) + 46px + 4px);
    z-index: 3;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    margin: 0 calc(-1 * var(--gutter)) 16px;
    padding: 8px var(--gutter) 4px;
    background: var(--bg);
  }

  .prompts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
    margin: 0 0 18px;
  }

  .try {
    flex-shrink: 0;
    margin-right: 2px;
    color: var(--muted);
    font-size: 14px;
  }

  /* A phone: one line that scrolls sideways, so the grid starts on the first screen. */
  @media (width <= 759px) {
    .prompts {
      flex-wrap: nowrap;
      margin-inline: calc(-1 * var(--gutter));
      padding-inline: var(--gutter);
      overflow-x: auto;
      scrollbar-width: none;
    }

    .prompts::-webkit-scrollbar {
      display: none;
    }

    .prompts button {
      flex-shrink: 0;
      white-space: nowrap;
    }
  }

  .prompts button {
    min-height: 30px;
    padding: 0 10px;
    border: 1px dashed var(--line);
    border-radius: 999px;
    background: transparent;
    color: var(--fg);
    font: inherit;
    font-size: 14px;
    cursor: pointer;
  }

  .prompts button:hover {
    border-color: var(--muted);
  }

  .prompts button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* A wide screen: a rail down the side, as the TV's is, with the grid beside it. */
  @media (width >= 1100px) {
    .explore {
      display: grid;
      grid-template-columns: 220px minmax(0, 1fr);
      gap: 32px;
      align-items: start;
    }

    .rail {
      top: var(--bar-space);
      gap: 18px;
      max-height: calc(100vh - var(--bar-space) - 16px);
      margin: 0;
      padding: 0 4px 16px 0;
      overflow-y: auto;
      scrollbar-width: thin;
    }
  }
</style>
