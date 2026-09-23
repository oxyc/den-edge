<!-- People: the people credited on the titles a selection matches, most prominent first, as Explore browses titles —
     the same rail, pills and endless grid. Its person traits (role, gender, birth decade or years, nationality,
     occupation) lead the rail, then Explore's title facets, which scope which credits count ("directors of Korean
     horror"). Its state is its address (`/people?type=…&c=…&t=…&order=…`), so a view can be linked and Back takes back a pick.
     Text typed in the bar's search field here (`q=`) offers traits and facets by name, as Explore's Browse row does,
     and the people it names. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import ExploreChips from './ExploreChips.svelte';
  import ExploreTabs from './ExploreTabs.svelte';
  import FacetSuggestions from './FacetSuggestions.svelte';
  import Loading from './Loading.svelte';
  import Picks from './Picks.svelte';
  import SearchResults from './SearchResults.svelte';
  import TypeFilter from './TypeFilter.svelte';
  import Select from '../settings/Select.svelte';
  import {
    applyPick,
    chipsOf,
    filterChips,
    offered,
    pendingChip,
    remapSet,
    type Chip,
  } from '../lib/explore';
  import { countedEmpty } from '../lib/facetCounts';
  import {
    fetchFilterCounts,
    fetchPeopleCounts,
    filterPeople,
    FIRST_BIRTH_YEAR,
    mergeFilterValues,
    searchFilterValues,
    searchTraitValues,
    type FilterCounts,
    type FilterPerson,
    type FilterValue,
    type PeopleCounts,
  } from '../lib/filterRoutes';
  import type { ExploreType, MediaType } from '../lib/library';
  import { navigate } from '../lib/navigation';
  import {
    ORDERS,
    SECTIONS,
    bornRangeId,
    bornRangeOf,
    exploreFromPeople,
    peopleSuggestions,
    pendingTraitChip,
    pickTrait,
    titleChips,
    titleItems,
    traitChip,
    traitChips,
    traitEmpty,
    traitItem,
    traitItems,
    traitOffered,
  } from '../lib/people';
  import { peopleHref, searchHref, type PeopleView } from '../lib/route';
  import type { Hit } from '../lib/search';
  import { searchSources } from '../lib/searchSources';

  let {
    view = {},
    tmdbKey,
    atlas,
    atlasReady = true,
  }: {
    /** What is browsed, from the address. */
    view?: PeopleView;
    tmdbKey: string;
    atlas: string | null;
    /** Whether the search for atlas has finished: until then, no atlas is not yet an answer. */
    atlasReady?: boolean;
  } = $props();

  const type = $derived<ExploreType>(view.type ?? 'all');
  // Strings, so an identical list from a new address is not a new list.
  const chipsKey = $derived((view.chips ?? []).join(','));
  const traitsKey = $derived((view.traits ?? []).join(','));
  const chips = $derived(chipsKey ? chipsKey.split(',') : []);
  const traits = $derived(traitsKey ? traitsKey.split(',') : []);
  const order = $derived(view.order ?? 'prominence');
  const query = $derived(view.query ?? '');
  const typing = $derived(query.trim().length >= 2);

  /** Each pick, type and order is somewhere a person went: its own history entry. What is typed stays. */
  function go(next: PeopleView) {
    navigate(
      peopleHref({ query: view.query, type: view.type, chips, traits, order: view.order, ...next }),
    );
  }

  // The people, a page at a time. Only what reaches atlas starts the list again.
  const feed = $derived(
    atlas ? filterPeople(atlas, type, titleItems(chips, type), traitItems(traits), order) : null,
  );
  let people = $state<FilterPerson[]>([]);
  let total = $state<number | null>(null);
  let done = $state(false);
  let failed = $state(false);
  let page = 0;
  let loading = false;
  let current: typeof feed = null;

  /** The next page; and the one after while a page brings no one Den can draw (no TMDB id, no page to open). */
  async function more() {
    const load = current;
    if (!load || loading || done) return;
    loading = true;
    try {
      for (let burst = 0; burst < 3 && !done; burst++) {
        const answer = await load(page + 1);
        if (load !== current) return;
        page++;
        const seen = new Set(people.map((p) => p.id));
        const fresh = answer.people.filter((p) => !seen.has(p.id));
        people = [...people, ...fresh];
        total = answer.total;
        if (!answer.people.length || people.length >= answer.total) done = true;
        if (fresh.some((p) => p.tmdbId !== undefined)) break;
      }
    } catch (error) {
      if (load !== current) return;
      console.warn('people: page', page + 1, 'failed', error);
      failed = true;
      done = true;
    } finally {
      if (load === current) loading = false;
    }
  }

  let first = true;
  $effect(() => {
    const load = feed;
    untrack(() => {
      current = load;
      people = [];
      total = null;
      failed = false;
      done = load === null;
      page = 0;
      loading = false;
      // A new selection starts at the top of the page, as a new page would.
      if (!first) window.scrollTo({ top: 0, behavior: 'instant' });
      first = false;
      void more();
    });
  });

  // Each person's photo, from TMDB as a person's page and search draw them.
  const sources = $derived(searchSources(tmdbKey, undefined, atlas));
  let photos = $state<Record<number, string | null>>({});
  $effect(() => {
    const from = sources;
    for (const id of [...people, ...byName].map((p) => p.tmdbId)) {
      if (id === undefined || untrack(() => id in photos)) continue;
      photos[id] = null;
      from
        .person(id)
        .then((found) => {
          if (found?.profilePath) photos[id] = found.profilePath;
        })
        .catch((error: unknown) => console.warn('people: no photo for', id, error));
    }
  });
  /** People as cards: each once, and only those with a TMDB id, their page's address. */
  const cards = (list: { tmdbId?: number; name: string; knownFor?: { title: string }[] }[]) => {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Local to one derivation; nothing renders from it.
    const seen = new Set<number>();
    return list.flatMap((p): Hit[] => {
      if (p.tmdbId === undefined || seen.has(p.tmdbId)) return [];
      seen.add(p.tmdbId);
      return [
        {
          kind: 'person',
          person: {
            id: p.tmdbId,
            name: p.name,
            profilePath: photos[p.tmdbId] ?? undefined,
            ...(p.knownFor ? { knownFor: p.knownFor.map((t) => t.title) } : {}),
          },
        },
      ];
    });
  };
  const hits = $derived(cards(people));

  /**
   * atlas's counts beside the selection, a moment after it settles: the traits' (who would be left) and the titles'
   * (which title facets have titles). They judge what would leave nothing only beside the selection they were
   * counted for; the options they list stay from the last answer until the next.
   */
  let counts = $state<{
    key: string;
    people: PeopleCounts | null;
    titles: FilterCounts | null;
  } | null>(null);
  const countsKey = $derived(`${type}|${chipsKey}|${traitsKey}`);
  $effect(() => {
    const [here, key, t] = [atlas, countsKey, type];
    const [items, picked] = [titleItems(chips, t), traitItems(traits)];
    if (!here) return;
    const ask = new AbortController();
    const signal = ask.signal;
    const timer = setTimeout(async () => {
      const [byTrait, byTitle] = await Promise.all([
        fetchPeopleCounts(here, t, items, picked, { signal }),
        fetchFilterCounts(here, t, items, { signal }),
      ]);
      if (!signal.aborted) counts = { key, people: byTrait, titles: byTitle };
    }, 150);
    return () => {
      clearTimeout(timer);
      ask.abort();
    };
  });
  const fresh = $derived(counts?.key === countsKey ? counts : null);

  const listedGroups = new Set(SECTIONS.map(([group]) => group));
  /** The rail's options: the traits atlas counted, Explore's title facets, and the title facets only atlas lists. */
  const listed = $derived(
    [
      ...(counts?.people ? traitChips(counts.people) : []),
      ...titleChips(type),
      ...(counts?.titles ? filterChips(counts.titles) : []),
    ].filter(
      (chip, at, all) =>
        listedGroups.has(chip.group) && all.findIndex((other) => other.id === chip.id) === at,
    ),
  );
  /** Nationalities and occupations picked from the find field, by id: their names, for their pills. */
  let named = $state<Record<string, Chip>>({});
  const known = $derived.by(() => {
    const all = [...listed, ...Object.values(named)];
    for (const id of [...traits, ...chips]) {
      const pending =
        !all.some((chip) => chip.id === id) && (pendingTraitChip(id) ?? pendingChip(id));
      if (pending) all.push(pending);
    }
    return all;
  });
  const names = (ids: string[]) =>
    chipsOf(ids, known)
      .map((c) => c.label)
      .join(', ');
  const picked = $derived(chipsOf([...traits, ...chips], known).map((chip) => ({ chip })));

  /**
   * Hidden: a trait value of a one-value trait already picked, a title facet that can't stand beside the picks, and
   * whatever atlas's counts say would leave nothing (only where they list a kind completely).
   */
  const hidden = (id: string) => {
    if (traitItem(id))
      return !traitOffered(traits, id) || (!!fresh?.people && traitEmpty(id, fresh.people));
    if (!offered(chips, id, type, true)) return true;
    return !!fresh?.titles && countedEmpty(id, type, fresh.titles.kinds);
  };

  /** What gave way to the last pick, said once. */
  let status = $state('');
  /** A pick from the rail, a pill or the Browse row; `text` is what the search field keeps. */
  function pick(id: string, text = query) {
    const label = known.find((c) => c.id === id)?.label ?? '';
    if (traitItem(id)) {
      const next = pickTrait(traits, id);
      const removed = traits.filter((x) => x !== id && !next.includes(x));
      status = removed.length ? `${label} replaced ${names(removed)}.` : '';
      go({ traits: next, query: text });
      return;
    }
    const { set, removed } = applyPick(chips, id, type, true);
    status = removed.length ? `${label} replaced ${names(removed)}.` : '';
    go({ chips: set, query: text });
  }

  /**
   * The birth-year range's fields, as typed; set again from the address whenever it changes. A range is one `born`
   * pick, so it takes the place of a birth decade, as another decade would.
   */
  let bornFrom = $state('');
  let bornTo = $state('');
  $effect(() => {
    const range = bornRangeOf(traits);
    bornFrom = range?.from?.toString() ?? '';
    bornTo = range?.to?.toString() ?? '';
  });
  function chooseYears() {
    const latest = new Date().getFullYear() + 1;
    const year = (text: string) => (text.trim() ? Number(text.trim()) : undefined);
    const [from, to] = [year(bornFrom), year(bornTo)];
    if (
      [from, to].some(
        (y) => y !== undefined && !(Number.isInteger(y) && y >= FIRST_BIRTH_YEAR && y <= latest),
      )
    ) {
      status = `Born: a year from ${FIRST_BIRTH_YEAR} to ${latest}.`;
      return;
    }
    if (from !== undefined && to !== undefined && from > to) {
      status = `Born: ${from} is after ${to}.`;
      return;
    }
    const id = bornRangeId(from, to);
    const born = traits.filter((x) => traitItem(x)?.kind === 'born');
    // Emptied fields take out a range, and leave a decade be.
    if (!id && !bornRangeOf(traits)) return;
    const next = [...traits.filter((x) => !born.includes(x)), ...(id ? [id] : [])];
    if (next.join(',') === traits.join(',')) return;
    const removed = id ? born.filter((x) => x !== id) : [];
    status = removed.length ? `${pendingTraitChip(id!)?.label} replaced ${names(removed)}.` : '';
    go({ traits: next });
  }

  function chooseType(to: MediaType | null) {
    const next: ExploreType = to ?? 'all';
    const { set, dropped } = remapSet(chips, type, next, titleChips(next));
    status = dropped.length ? `${names(dropped)}: none in that type.` : '';
    go({ type: to ?? undefined, chips: set });
  }

  function clearAll() {
    status = '';
    go({ chips: [], traits: [] });
  }

  /**
   * What the typed text finds, beside the selection, a moment after typing settles: nationalities and occupations by
   * name, past the rail's strongest few, and the people credited there by that name. Under All, where atlas may have
   * no `all` route for names, each type's answers together.
   */
  let found = $state<Chip[]>([]);
  let byName = $state<FilterValue[]>([]);
  let finding = $state(false);
  $effect(() => {
    const q = query.trim();
    const [here, t] = [atlas, type];
    const [items, picks] = [titleItems(chips, t), traitItems(traits)];
    found = [];
    byName = [];
    finding = false;
    if (!here || q.length < 2) return;
    finding = true;
    const ask = new AbortController();
    const options = { signal: ask.signal };
    const timer = setTimeout(async () => {
      const kinds = ['citizenship', 'occupation'];
      const names = async () => {
        const answer = await searchFilterValues(here, t, 'person', q, items, options);
        if (answer || t !== 'all') return answer ?? [];
        const sides = await Promise.all(
          (['movie', 'tv'] as const).map((side) =>
            searchFilterValues(here, side, 'person', q, titleItems(chips, side), options),
          ),
        );
        return mergeFilterValues(sides);
      };
      const [answers, people] = await Promise.all([
        Promise.all(
          kinds.map((kind) => searchTraitValues(here, t, kind, q, items, picks, options)),
        ),
        names(),
      ]);
      if (ask.signal.aborted) return;
      found = kinds.flatMap((kind, at) =>
        (answers[at] ?? []).flatMap(
          (value) => traitChip(kind, value.id, { [value.id]: value.name }) ?? [],
        ),
      );
      byName = people;
      finding = false;
    }, 250);
    return () => {
      clearTimeout(timer);
      ask.abort();
    };
  });
  const matches = $derived(cards(byName));
  /** The Browse row: what the text names, not yet picked and able to stand beside the picks. */
  const suggested = $derived(
    typing
      ? peopleSuggestions(
          query,
          listed,
          found,
          (id) => ![...traits, ...chips].includes(id) && !hidden(id),
        )
      : [],
  );
  /** A suggestion picked: it joins the picks, and the text it was found by goes. */
  function pickFound(chip: Chip) {
    named[chip.id] = chip;
    pick(chip.id, '');
  }
</script>

<section class="people" aria-label="People" aria-busy={total === null && !done}>
  <ExploreTabs
    current="people"
    explore={searchHref('', exploreFromPeople(view))}
    people={peopleHref({ type: view.type, chips, traits, order: view.order })}
  />
  {#if !atlas && atlasReady}
    <p class="note">People comes from atlas, which this page can’t reach right now.</p>
  {:else if !atlas}
    <Loading label="Loading" />
  {:else}
    <div class="explore">
      <div class="rail">
        <TypeFilter
          value={view.type ?? null}
          onchange={chooseType}
          label="People in movies, series or both"
        />
        <!-- Taken on Enter, or once focus leaves both fields: moving from one to the other is not a pick. -->
        <div
          class="years"
          role="group"
          aria-label="Born between"
          onfocusout={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) chooseYears();
          }}
        >
          <input
            class="find"
            type="text"
            inputmode="numeric"
            maxlength="4"
            autocomplete="off"
            placeholder="Born from"
            aria-label="Born from (year)"
            bind:value={bornFrom}
            onkeydown={(event) => event.key === 'Enter' && chooseYears()}
          />
          <span aria-hidden="true">–</span>
          <input
            class="find"
            type="text"
            inputmode="numeric"
            maxlength="4"
            autocomplete="off"
            placeholder="to"
            aria-label="Born to (year)"
            bind:value={bornTo}
            onkeydown={(event) => event.key === 'Enter' && chooseYears()}
          />
        </div>
        <ExploreChips
          chips={listed}
          selected={[...traits, ...chips]}
          {hidden}
          sections={SECTIONS}
          strip={['role', 'gender', 'born']}
          onchange={pick}
        />
      </div>
      <div class="feed">
        {#if !typing}
          <div class="bar">
            <p class="total">
              {total === null
                ? ''
                : `${total.toLocaleString()} ${total === 1 ? 'person' : 'people'}`}
            </p>
            <Select
              label="Sort people"
              value={order}
              options={ORDERS}
              onchange={(value) => go({ order: value === 'prominence' ? undefined : value })}
            />
          </div>
        {/if}
        <Picks picks={picked} onremove={(id) => pick(id)} onclear={clearAll} />
        <p class="status" role="status">{status}</p>
        {#if typing}
          <!-- Picking one turns the text into it, as on Explore: the text goes, the pick stays. -->
          <FacetSuggestions chips={suggested} {query} onpick={pickFound} />
          {#if matches.length}
            <section aria-label="People by that name">
              <SearchResults hits={matches} />
            </section>
          {:else if finding}
            <Loading label="Searching" />
          {:else}
            <p class="note" role="status">No one by that name.</p>
          {/if}
        {:else if hits.length}
          <SearchResults {hits} onend={() => void more()} />
        {:else if failed}
          <p class="note" role="status">Couldn’t load people right now. Try again in a moment.</p>
        {:else if done}
          <p class="note" role="status">No one matches these picks. Take one out above.</p>
        {:else}
          <Loading label="Loading people" />
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .note,
  .total {
    color: var(--muted);
  }

  .status {
    margin: 0;
    color: var(--muted);
    font-size: 14px;
  }

  .status:not(:empty) {
    margin-bottom: 12px;
  }

  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 0 0 8px;
  }

  .total {
    margin: 0;
    font-size: 14px;
  }

  /* A phone and a tablet: the type, the birth years and one line of chips over the grid. */
  .rail {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    margin: 0 0 12px;
  }

  .find {
    align-self: stretch;
    min-height: 36px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--card);
    color: var(--fg);
    font: inherit;
    font-size: 16px;
  }

  .find:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  /* The birth-year range: two find fields side by side. */
  .years {
    display: flex;
    align-items: center;
    gap: 6px;
    align-self: stretch;
    color: var(--muted);
  }

  .years .find {
    flex: 1;
    min-width: 0;
  }

  /* A wide screen: the rail down the side, as Explore's is, with the grid beside it. */
  @media (width >= 1100px) {
    .explore {
      display: grid;
      grid-template-columns: 220px minmax(0, 1fr);
      gap: 32px;
      align-items: start;
    }

    .rail {
      position: sticky;
      top: var(--bar-space);
      gap: 18px;
      max-height: calc(100vh - var(--bar-space) - 16px);
      margin: 0;
      padding: 0 4px 16px 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      scrollbar-width: thin;
    }

    .find {
      font-size: 14px;
    }
  }
</style>
