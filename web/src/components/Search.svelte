<!-- Search, browse-first (the TV's Explore, oxyc/den#69). Before anything is typed: Movies or Series, one chip open —
     For You, a genre, a recipe or a mood — and the endless grid it fills. Typing searches instead, and clearing the
     query returns to the chip that was open, since the address still names it. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import ExploreChips from './ExploreChips.svelte';
  import Loading from './Loading.svelte';
  import SearchResults from './SearchResults.svelte';
  import TypeFilter from './TypeFilter.svelte';
  import { equivalentGenre, tmdbPages } from '../lib/catalog';
  import {
    applyPick,
    chipsOf,
    emptyOptions,
    exploreChips,
    exploreFeed,
    KIND,
    offered,
    PROMPTS,
    remapSet,
    slotOf,
    suggestChips,
  } from '../lib/explore';
  import type { MediaType, Title } from '../lib/library';
  import { navigate } from '../lib/navigation';
  import { Pager } from '../lib/pager.svelte';
  import { isHidden, type Prefs } from '../lib/prefs';
  import { searchHref, type Explore } from '../lib/route';
  import { searchStream, type Hit } from '../lib/search';
  import { searchSources } from '../lib/searchSources';
  import { fetchFacetCounts, type FacetCounts } from '../lib/facetCounts';

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
    exploreChips(type, {
      hiddenGenres: prefs.excludedGenres,
      atlas: atlas !== null,
      minYear: prefs.minReleaseYear,
    });
  const chips = $derived(chipsFor(exploreType));
  /** The facets picked, as the address holds them; a string, so an identical list is not a new one. */
  const selectionKey = $derived((explore.chips ?? []).join(','));
  const selection = $derived(selectionKey ? selectionKey.split(',') : []);
  const names = (ids: string[]) =>
    chipsOf(ids, chips)
      .map((c) => c.label)
      .join(', ');
  /** What gave way to the last pick, said once: "Nordic Noir replaced Korean." */
  let status = $state('');

  /** Each pick and type is somewhere a person went, so each gets its own history entry. */
  function go(next: Explore, text = query) {
    navigate(searchHref(text, next));
  }

  /** The selection moves with the type, genres to their closest counterparts (SearchModel.setScope). */
  function chooseType(type: MediaType | null) {
    const to = type ?? 'movie';
    const { set, dropped } = remapSet(selection, exploreType, to, chipsFor(to));
    status = dropped.length
      ? `${names(dropped)}: nothing like it in ${to === 'tv' ? 'series' : 'movies'}.`
      : '';
    go({ type: type ?? undefined, chips: set });
  }

  // The selection's feed. Only the selection, and what reaches TMDB and atlas, start it again: a new seed or a write
  // elsewhere must not empty a grid someone is scrolling. It waits while a query is typed, and is still where it
  // was once the query is cleared.
  const feed = $derived.by(() => {
    const row = exploreFeed(selectionKey ? selectionKey.split(',') : [], exploreType, {
      pages: tmdbPages(tmdbKey),
      atlas,
      seeds: untrack(() => seeds),
      owned: untrack(() => owned),
      minYear: prefs.minReleaseYear,
      title: sources.title,
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

  /**
   * The genres picked narrow typed results, as the type does. The other facets can't be combined with a query —
   * atlas ranks a mood's row, and TMDB's search takes no genre or country — so while a query is typed they wait,
   * unapplied and out of the Selected group, until it is cleared.
   */
  const narrowing = $derived(
    typing ? selection.filter((id) => slotOf(id) === 'genre').map((id) => Number(id.slice(6))) : [],
  );
  /** A title in `genre` of the browsed type, or in its closest counterpart for a title of the other type. */
  const inGenre = (title: Title, genre: number) => {
    const ids = title.genreIds ?? [];
    return ids.includes(equivalentGenre(genre, exploreType, title.type) ?? genre);
  };
  /** Typed results of the chosen type and genres; people only under All, as on the TV, and never in a genre. */
  const typedHits = $derived(
    (hits ?? []).filter((hit) =>
      hit.kind === 'person'
        ? explore.type === undefined && narrowing.length === 0
        : (explore.type === undefined || hit.title.type === explore.type) &&
          narrowing.every((genre) => inGenre(hit.title, genre)),
    ),
  );

  /**
   * A chip picked, from the rail, a pill or a suggestion. It stacks onto the selection, or comes out if it was in it,
   * and whatever it can't stand beside gives way, said in the status line. While a query is typed, a genre narrows
   * its results and the query stays; anything else opens the selection's feed in the query's place — a new entry,
   * so Back returns to the search.
   */
  function pick(id: string) {
    const { set, removed } = applyPick(selection, id, exploreType);
    const label = chips.find((c) => c.id === id)?.label ?? '';
    status = removed.length ? `${label} replaced ${names(removed)}.` : '';
    const keep = typing && slotOf(id) === 'genre';
    go({ type: explore.type, chips: set }, keep ? query : '');
  }

  /** What is shown as picked: everything, or while typing only the genres that narrow the results. */
  const shownSelection = $derived(
    typing ? selection.filter((id) => slotOf(id) === 'genre') : selection,
  );
  const picked = $derived(chipsOf(shownSelection, chips));

  /** Every pick shown taken out at once. While typing that is the genres narrowing it; the query stays. */
  function clearAll() {
    status = '';
    go(
      {
        type: explore.type,
        chips: typing ? selection.filter((id) => slotOf(id) !== 'genre') : [],
      },
      typing ? query : '',
    );
  }
  /**
   * atlas's counts beside the selection (`facetCounts.ts`): one request per selection, a moment after it settles,
   * the last one dropped when the next begins. Null where atlas has none to give, which leaves the feed to judge.
   */
  let counts = $state<FacetCounts | null>(null);
  $effect(() => {
    const here = atlas;
    const type = exploreType;
    const set = selectionKey ? selectionKey.split(',') : [];
    counts = null;
    if (!here || typing) return;
    const ask = new AbortController();
    const timer = setTimeout(async () => {
      const answer = await fetchFacetCounts(here, type, set, { signal: ask.signal });
      if (!ask.signal.aborted) counts = answer;
    }, 150);
    return () => {
      clearTimeout(timer);
      ask.abort();
    };
  });
  /**
   * Options not worth offering: any that can't stand beside the selection, and any that would show nothing beside
   * it (`emptyOptions`: atlas's counts, and the feed once it has loaded to its end).
   */
  const empty = $derived(
    typing
      ? new Set<string>()
      : emptyOptions(
          selection,
          feedHits
            .map((hit) => (hit.kind === 'title' ? hit.title : null))
            .filter((t) => t !== null),
          feed.pager.exhausted,
          chips,
          { counts, type: exploreType },
        ),
  );
  const hidden = (id: string) => !offered(shownSelection, id, exploreType) || empty.has(id);

  /** The categories the typed text points at, offered above its results: local, instant. */
  const suggestions = $derived(
    typing ? suggestChips(query, chips).filter((c) => !hidden(c.id)) : [],
  );
</script>

<section
  class="search"
  aria-label={typing ? 'Search results' : 'Explore'}
  aria-busy={typing ? pending : feed.pager.page === 0 && !feed.pager.done}
>
  <h1>{typing ? 'Search' : 'Explore'}</h1>
  <div class="explore">
    <div class="rail">
      {#if typing}
        <TypeFilter
          value={explore.type ?? null}
          onchange={chooseType}
          label="Show in search results"
        />
      {:else}
        <TypeFilter
          value={exploreType}
          onchange={chooseType}
          label="Browse movies or series"
          all={false}
        />
      {/if}
      <ExploreChips {chips} selected={shownSelection} {hidden} {typing} onchange={pick} />
    </div>
    <div class="feed">
      <!-- The picks, over what they pick, at every width: quiet, since the grid is what they are about. -->
      {#if picked.length}
        <div class="picks" role="group" aria-label="Selected">
          {#each picked as item (item.id)}
            <button
              type="button"
              class="pick"
              aria-label="Remove {item.label}"
              data-chip={item.id}
              onclick={() => pick(item.id)}
              >{item.label}<span class="x" aria-hidden="true">✕</span></button
            >
          {/each}
          <button type="button" class="clear" onclick={clearAll}>Clear all</button>
        </div>
      {/if}
      <p class="status" role="status">{status}</p>
      {#if typing}
        {#if suggestions.length}
          <div class="prompts" role="group" aria-label="Browse instead">
            <span class="try">Browse</span>
            {#each suggestions as suggestion (suggestion.id)}
              <button type="button" onclick={() => pick(suggestion.id)}
                >{suggestion.label}<span class="kind">{` · ${KIND[suggestion.group]}`}</span
                ></button
              >
            {/each}
          </div>
        {/if}
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
        {#if !selection.length}
          <div class="prompts" role="group" aria-label="Try describing it">
            <span class="try">Try describing it</span>
            {#each PROMPTS as prompt (prompt)}
              <button type="button" onclick={() => go({ type: explore.type }, prompt)}
                >“{prompt}”</button
              >
            {/each}
          </div>
        {/if}
        {#if feedHits.length}
          <SearchResults hits={feedHits} onend={() => void feed.pager.more()} />
        {:else if feed.pager.done}
          <p class="note">Nothing here yet. Try taking a pick out.</p>
        {:else}
          <Loading label="Loading" />
        {/if}
      {/if}
    </div>
  </div>
</section>

<style>
  h1 {
    font-size: 28px;
    margin: 8px 0 16px;
  }

  .kind {
    color: var(--muted);
  }

  .note {
    color: var(--muted);
  }

  .status {
    margin: 0;
    color: var(--muted);
    font-size: 14px;
  }

  /* The picks: small, outlined, muted — a note of what is applied, not chips competing with the rail's. */
  .picks {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin: 0 0 14px;
  }

  .pick {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    min-height: 28px;
    padding: 0 8px 0 10px;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 13px;
    white-space: nowrap;
    text-overflow: ellipsis;
    cursor: pointer;
  }

  .pick:hover {
    border-color: var(--muted);
    color: var(--fg);
  }

  .x {
    font-size: 10px;
  }

  .clear {
    min-height: 28px;
    margin-left: 6px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 13px;
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
  }

  .clear:hover {
    color: var(--fg);
  }

  .pick:focus-visible,
  .clear:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .status:not(:empty) {
    margin-bottom: 12px;
  }

  /* The last results, while the next ones load. */
  .stale {
    opacity: 0.6;
    transition: opacity 120ms;
  }

  /* A phone and a tablet: the type and one line of chips over the grid, held under the bar as it scrolls. */
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

  /* A phone: the prompts are one line that scrolls sideways too, so the grid starts on the first screen. */
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

  /* Inset: on a phone this row scrolls sideways, and would clip a ring drawn outside it. */
  .prompts button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
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
