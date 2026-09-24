<!-- Search, browse-first (the TV's Explore, oxyc/den#69). Before anything is typed: All, Movies or Series — All by
     default — one chip open — For You, a genre, a recipe or a mood — and the endless grid it fills. Typing searches
     instead, and clearing the query returns to the chip that was open, since the address still names it. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import ExploreChips from './ExploreChips.svelte';
  import ExploreTabs from './ExploreTabs.svelte';
  import FacetSuggestions from './FacetSuggestions.svelte';
  import Loading from './Loading.svelte';
  import Picks from './Picks.svelte';
  import SearchResults from './SearchResults.svelte';
  import TypeFilter from './TypeFilter.svelte';
  import { equivalentGenre, tmdbPages } from '../lib/catalog';
  import {
    applyPick,
    chipsOf,
    emptyOptions,
    exploreChips,
    exploreFeed,
    filterChips,
    likeChip,
    offered,
    pendingChip,
    perType,
    taken,
    PROMPTS,
    remapSet,
    slotOf,
    browseChips,
    countedEmptyAcross,
    pillOrder,
    type Chip,
  } from '../lib/explore';
  import { countItems, filterItems, groupKind } from '../lib/facetCounts';
  import {
    fetchFilterCounts,
    mergeFilterValues,
    searchFilterValues,
    type FilterCounts,
  } from '../lib/filterRoutes';
  import type { ExploreType, MediaType, Title } from '../lib/library';
  import { navigate } from '../lib/navigation';
  import { Pager } from '../lib/pager.svelte';
  import { peopleFromExplore } from '../lib/people';
  import { isHidden, type Prefs } from '../lib/prefs';
  import { FACET, likeId, likeOf, peopleHref, searchHref, type Explore } from '../lib/route';
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
    active = true,
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
    /** The page on screen, rather than one kept behind it. */
    active?: boolean;
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
  /** The year floor by value: `prefs` is a new object whenever it is re-read, and the feed must not restart for that. */
  const minYear = $derived(prefs.minReleaseYear);

  // Explore and typed results both show every type until one is chosen: one `type` in the address for both.
  const exploreType = $derived<ExploreType>(explore.type ?? 'all');
  const chipsFor = (type: ExploreType) =>
    exploreChips(type, {
      hiddenGenres: prefs.excludedGenres,
      atlas: atlas !== null,
      minYear: prefs.minReleaseYear,
    });
  /** The facets picked, as the address holds them; a string, so an identical list is not a new one. */
  const selectionKey = $derived((explore.chips ?? []).join(','));
  const selection = $derived(selectionKey ? selectionKey.split(',') : []);

  /**
   * The names of the titles a "Like" is for, by facet id: set as one is picked, and looked up for one the address
   * brought, its pill saying "Like…" until then.
   */
  let likeNames = $state<Record<string, string>>({});
  const like = $derived(selection.find((id) => likeOf(id)));
  $effect(() => {
    const id = like;
    const ref = id && likeOf(id);
    if (!id || !ref || untrack(() => likeNames[id])) return;
    let current = true;
    sources
      .title(ref)
      .then((title) => {
        if (current && title) likeNames[id] = title.title;
      })
      .catch((error: unknown) => console.warn('search: no name for', id, error));
    return () => {
      current = false;
    };
  });
  /**
   * Whether atlas's filter has answered here: from then on, picks it can mix stand together (`clash`). Its counts
   * arrive after each pick, so this holds from the first answer rather than flickering with each.
   */
  let filtered = $state(false);
  /**
   * atlas's last counts, and the type and selection they were counted for (the effect further down): one answer, or
   * under All without atlas's `all` route, each type's (`sides`), which only judge an option together.
   */
  let filterAnswer = $state<{
    key: string;
    answers: FilterCounts[];
    sides?: { type: MediaType; counts: FilterCounts | null }[];
  } | null>(null);
  /** People and characters picked from the search field, by facet id: their names, for their pills. */
  let named = $state<Record<string, Chip>>({});
  /**
   * The rail's chips for the type, with those only atlas's filter knows from its last counts; and every chip a pill
   * can be for — a picked "Like", a typeahead's pick, and a pick of atlas's not yet named ("Person…").
   */
  const chips = $derived(chipsFor(exploreType));
  const listed = $derived(
    [...chips, ...(filterAnswer?.answers.flatMap(filterChips) ?? [])].filter(
      (chip, at, all) => all.findIndex((other) => other.id === chip.id) === at,
    ),
  );
  const known = $derived.by(() => {
    const all = [...listed, ...Object.values(named)];
    if (like) all.push(likeChip(like, likeNames[like]));
    for (const id of selection) {
      const pending = !all.some((chip) => chip.id === id) && pendingChip(id);
      if (pending) all.push(pending);
    }
    return all;
  });
  const names = (ids: string[]) =>
    chipsOf(ids, known)
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
    const to = type ?? 'all';
    const { set, dropped } = remapSet(selection, exploreType, to, chipsFor(to));
    status = dropped.length ? `${names(dropped)}: nothing like it in ${NOUN[to]}.` : '';
    go({ type: type ?? undefined, chips: set });
  }
  const NOUN: Record<ExploreType, string> = {
    all: 'films or series',
    movie: 'movies',
    tv: 'series',
  };

  /**
   * Under All, the picks one type has no form of, said as a standing note beside the status: "Horror: movies only."
   * Their type's feed is the grid (`perType`). A "Like" is both types' already.
   */
  const scope = $derived.by(() => {
    if (exploreType !== 'all' || typing || !selection.length || like) return '';
    return perType(selection)
      .map(({ type, dropped }) =>
        dropped.length ? `${names(dropped)}: ${type === 'tv' ? 'movies' : 'series'} only.` : '',
      )
      .filter(Boolean)
      .join(' ');
  });

  // The selection's feed. Only the selection, and what reaches TMDB and atlas, start it again: a new seed or a write
  // elsewhere must not empty a grid someone is scrolling. It waits while a query is typed, and is still where it
  // was once the query is cleared.
  const feed = $derived.by(() => {
    const row = exploreFeed(selectionKey ? selectionKey.split(',') : [], exploreType, {
      pages: tmdbPages(tmdbKey),
      atlas,
      seeds: untrack(() => seeds),
      owned: untrack(() => owned),
      minYear,
      title: sources.title,
      key: tmdbKey,
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

  // A new chip starts at the top of the page, as a new page would. On what was picked, not on the feed: the feed is
  // also rebuilt when atlas answers and after every library sync that brings a row, and this page stays mounted,
  // hidden, under a title opened from it — so a scroll on data arriving moved the title page back to its top.
  const selected = $derived(`${exploreType}:${selectionKey}`);
  let lastSelected = untrack(() => selected);
  $effect(() => {
    if (selected === lastSelected) return;
    lastSelected = selected;
    if (untrack(() => active)) window.scrollTo({ top: 0, behavior: 'instant' });
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
  /**
   * A title in `genre` of the browsed type (All's are the films'), or in its closest counterpart for a title of the
   * other type.
   */
  const inGenre = (title: Title, genre: number) => {
    const ids = title.genreIds ?? [];
    const space = exploreType === 'tv' ? 'tv' : 'movie';
    return ids.includes(equivalentGenre(genre, space, title.type) ?? genre);
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
   * A chip picked, from the rail, a pill or the Browse row. It stacks onto the selection, or comes out if it was in
   * it, and whatever it can't stand beside gives way, said in the status line. `keepQuery` says whether a typed query
   * stays: a rail genre narrows it, a pill taken out leaves it; anything else opens the selection's feed in the
   * query's place — a new entry, so Back returns to the search.
   */
  function pick(id: string, keepQuery = typing && slotOf(id) === 'genre') {
    const { set, removed } = applyPick(selection, id, exploreType, filtered);
    const label = known.find((c) => c.id === id)?.label ?? '';
    status = removed.length ? `${label} replaced ${names(removed)}.` : '';
    go({ type: explore.type, chips: set }, keepQuery ? query : '');
  }

  /**
   * "More like" a poster's title: its "Like" joins the selection, in the query's place. Under All it stays All, its
   * similar titles of both types; a title of the other type than the one browsed (a typed result) takes Explore to its
   * type, the other picks moving with it as `chooseType` moves them.
   */
  function likeTitle(title: Title) {
    const id = likeId(title);
    likeNames[id] = title.title;
    const to: ExploreType = exploreType === 'all' ? 'all' : title.type;
    const moved = remapSet(selection, exploreType, to, chipsFor(to));
    const { set, removed } = applyPick(moved.set, id, to, filtered);
    const gone = [...moved.dropped, ...removed];
    status = gone.length ? `Like ${title.title} replaced ${names(gone)}.` : '';
    go({ type: to === 'all' ? undefined : to, chips: set }, '');
  }

  /** What the rail treats as picked: everything, or while typing only the genres that narrow the results. */
  const shownSelection = $derived(
    typing ? selection.filter((id) => slotOf(id) === 'genre') : selection,
  );
  /**
   * Every pick, over the grid, a kind's values side by side where atlas's filter takes them as either-or. While a
   * query is typed, all but the genres wait: shown, but paused.
   */
  const picked = $derived(
    pillOrder(selection, (id) => (filtered ? groupKind(id, exploreType) : undefined)).flatMap(
      ({ id, or }) =>
        chipsOf([id], known).map((chip) => ({
          chip,
          or,
          paused: typing && slotOf(chip.id) !== 'genre',
        })),
    ),
  );

  /** Every pick taken out at once, the query left as it is. */
  function clearAll() {
    status = '';
    go({ type: explore.type, chips: [] }, typing ? query : '');
  }
  /**
   * atlas's counts beside the selection (`filterRoutes.ts`): one request per selection, a moment after it settles,
   * the last one dropped when the next begins. They judge what would show nothing only beside the selection they were
   * counted for; the options they list, and the pills' names, stay from the last answer until the next.
   *
   * Under All, where atlas has no `all` route, each type the grid shows is counted beside the selection as that type
   * asks it (`perType`), and an option is judged empty only where both say so (`countedEmptyAcross`).
   */
  $effect(() => {
    const here = atlas;
    const type = exploreType;
    const key = `${type}|${selectionKey}`;
    const set = selectionKey ? selectionKey.split(',') : [];
    if (!here || typing) return;
    const ask = new AbortController();
    const signal = ask.signal;
    const timer = setTimeout(async () => {
      const answer = await fetchFilterCounts(here, type, countItems(set, type), { signal });
      let next: typeof filterAnswer = answer ? { key, answers: [answer] } : null;
      if (!answer && type === 'all' && !signal.aborted) {
        const sides = await Promise.all(
          perType(set)
            .filter((side) => !side.dropped.length)
            .map(async (side) => ({
              type: side.type,
              counts: await fetchFilterCounts(here, side.type, countItems(side.set, side.type), {
                signal,
              }),
            })),
        );
        const answers = sides.flatMap((side) => side.counts ?? []);
        next = answers.length ? { key, answers, sides } : null;
      }
      if (signal.aborted) return;
      filterAnswer = next;
      if (next) filtered = true;
    }, 150);
    return () => {
      clearTimeout(timer);
      ask.abort();
    };
  });
  const current = $derived(
    filterAnswer?.key === `${exploreType}|${selectionKey}` ? filterAnswer : null,
  );
  const counts = $derived(current && !current.sides ? (current.answers[0]?.kinds ?? null) : null);
  const counted = $derived.by(() => {
    const sides = current?.sides?.map((side) => ({
      type: side.type,
      counts: side.counts?.kinds ?? null,
    }));
    return sides ? (id: string) => countedEmptyAcross(id, sides) : null;
  });

  /**
   * People and characters the typed text names, from atlas's filter, beside the selection: a person by name as a
   * maker ("director/writer") or else as cast ("actor"), a character from three letters. Asked a moment after
   * typing settles; none where atlas has no such route. Under All, where atlas has no `all` route, each type's
   * answers together.
   */
  let found = $state<Chip[]>([]);
  $effect(() => {
    const text = query.trim();
    const here = atlas;
    const type = exploreType;
    const set = selectionKey ? selectionKey.split(',') : [];
    found = [];
    if (!here || text.length < 2) return;
    const ask = new AbortController();
    const timer = setTimeout(async () => {
      const options = { signal: ask.signal };
      const values = async (kind: string) => {
        const answer = await searchFilterValues(
          here,
          type,
          kind,
          text,
          filterItems(set, type) ?? [],
          options,
        );
        if (answer || type !== 'all') return answer ?? [];
        const sides = perType(set).filter((side) => !side.dropped.length);
        return mergeFilterValues(
          await Promise.all(
            sides.map((side) =>
              searchFilterValues(
                here,
                side.type,
                kind,
                text,
                filterItems(side.set, side.type) ?? [],
                options,
              ),
            ),
          ),
        );
      };
      const [made, cast, characters] = await Promise.all([
        values('made'),
        values('cast'),
        values('character'),
      ]);
      if (ask.signal.aborted) return;
      const makers = new Set(made.map((value) => value.id));
      const people = [...made, ...cast.filter((value) => !makers.has(value.id))].map(
        (value): Chip => ({
          id: `person-${value.id}`,
          label: value.name,
          group: 'people',
          kind: makers.has(value.id) ? 'director/writer' : 'actor',
        }),
      );
      found = [
        ...people,
        ...characters.map((value): Chip => ({
          id: `character-${value.id}`,
          label: value.name,
          group: 'character',
        })),
      ].filter((chip) => FACET.test(chip.id));
    }, 250);
    return () => {
      clearTimeout(timer);
      ask.abort();
    };
  });

  /** A typeahead's pick: its name is kept, for its pill, as a "Like"'s is. */
  function pickFound(chip: Chip) {
    if (chip.group === 'people' || chip.group === 'character') named[chip.id] = chip;
    pick(chip.id, false);
  }
  /**
   * Options not worth offering: any that can't stand beside the selection, and any that would show nothing beside
   * it (`emptyOptions`: atlas's counts, and the feed's loaded titles). Judged while a query is typed too: a pick from
   * the Browse row lands in the paused selection's feed, whose loaded titles are still here.
   */
  const empty = $derived(
    emptyOptions(
      selection,
      feedHits.map((hit) => (hit.kind === 'title' ? hit.title : null)).filter((t) => t !== null),
      feed.pager.exhausted,
      listed,
      { counts, counted, type: exploreType, filtered },
    ),
  );
  /**
   * Hidden: what can't stand beside the selection, any other value of a one-value kind already picked — paused or not,
   * so a paused language still keeps the Browse row from offering a second — and what would show nothing.
   */
  const hidden = (id: string) =>
    !offered(shownSelection, id, exploreType, filtered) ||
    taken(selection, id, filtered) ||
    empty.has(id);
  /**
   * The pick to take out when the selection shows nothing: the latest, since it is what emptied a feed that had
   * titles before it. (atlas's counts say what adding an option leaves, not what removing a pick would bring back,
   * and asking TMDB once per pick to find out is more than an empty page is worth.)
   */
  const culprit = $derived(chipsOf(selection.slice(-1), known)[0]);
  /** "More like this" on the posters, while no "Like" is picked: one at a time, removed before another. */
  const onlike = $derived(like ? undefined : likeTitle);

  /**
   * The ways to browse the typed text points at, offered above its results: the categories it names, local, instant
   * and uncapped; then the people and characters atlas finds by it.
   */
  const browse = $derived(
    typing
      ? [...browseChips(query, listed), ...found].filter(
          (c, at, all) =>
            !selection.includes(c.id) &&
            !hidden(c.id) &&
            all.findIndex((other) => other.id === c.id) === at,
        )
      : [],
  );
</script>

<!-- The type and the rail. While a query is typed the rail follows the results in the page, so they come first in
     focus order; a wide screen still draws it down the side. -->
{#snippet rail()}
  <div class="rail" class:after={typing}>
    {#if !typing}
      <TypeFilter
        value={explore.type ?? null}
        onchange={chooseType}
        label="Browse movies, series or both"
      />
    {/if}
    <ExploreChips
      chips={listed}
      selected={shownSelection}
      {hidden}
      {typing}
      onchange={(id) => pick(id)}
    />
  </div>
{/snippet}

<section
  class="search"
  aria-label={typing ? 'Search results' : 'Explore'}
  aria-busy={typing ? pending : feed.pager.page === 0 && !feed.pager.done}
>
  {#if typing}
    <h1>Search</h1>
  {:else}
    <ExploreTabs
      current="explore"
      explore={searchHref('', explore)}
      people={peopleHref(peopleFromExplore(explore))}
    />
  {/if}
  <div class="explore">
    {#if !typing}{@render rail()}{/if}
    <div class="feed">
      {#if typing}
        <div class="controls">
          <TypeFilter
            value={explore.type ?? null}
            onchange={chooseType}
            label="Show in search results"
          />
        </div>
      {/if}
      <!-- The picks, over what they pick, at every width: quiet, since the grid is what they are about. -->
      <Picks picks={picked} onremove={(id) => pick(id, typing)} onclear={clearAll} />
      <p class="status" role="status">{[status, scope].filter(Boolean).join(' ')}</p>
      {#if typing}
        <!-- Picking one turns the query into it: the query goes, the pick stays, Back brings the query back. -->
        <FacetSuggestions chips={browse} {query} onpick={pickFound} />
        {#if hits === null}
          <Loading label="Searching" />
        {:else if typedHits.length}
          <div class:stale={pending}><SearchResults hits={typedHits} {onlike} /></div>
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
          <SearchResults hits={feedHits} onend={() => void feed.pager.more()} {onlike} />
        {:else if feed.pager.done && culprit}
          <p class="note empty" role="status">
            No results with {culprit.label}.
            <button type="button" class="clear" onclick={() => pick(culprit.id, false)}
              >Remove {culprit.label}</button
            >
          </p>
        {:else if feed.pager.done}
          <p class="note">Nothing here yet. Try taking a pick out.</p>
        {:else}
          <Loading label="Loading" />
        {/if}
      {/if}
    </div>
    {#if typing}{@render rail()}{/if}
  </div>
</section>

<style>
  h1 {
    font-size: 28px;
    margin: 8px 0 16px;
  }

  .note {
    color: var(--muted);
  }

  .status {
    margin: 0;
    color: var(--muted);
    font-size: 14px;
  }

  /* The empty state's way out: a quiet underlined word, read at the sentence's size. */
  .clear {
    min-height: 28px;
    margin-left: 6px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--muted);
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
  }

  .clear:hover {
    color: var(--fg);
  }

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

  /* A phone and a tablet: the type and one line of chips over the grid. Not pinned: only the bar stays on screen,
     so a phone keeps its height for the grid, and nothing draws a band under the bar's glass. */
  .rail {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    margin: 0 0 12px;
  }

  .controls {
    display: flex;
    margin: 0 0 12px;
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

    /* The rail keeps its column whether it comes before the results in the page or after them. */
    .rail {
      position: sticky;
      top: var(--bar-space);
      grid-column: 1;
      grid-row: 1;
      gap: 18px;
      max-height: calc(100vh - var(--bar-space) - 16px);
      margin: 0;
      padding: 0 4px 16px 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      scrollbar-width: thin;
    }

    .feed {
      grid-column: 2;
      grid-row: 1;
    }
  }
</style>
