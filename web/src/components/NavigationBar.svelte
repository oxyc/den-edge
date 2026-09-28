<script lang="ts">
  import icon from '../assets/den-mark.svg';
  import DetailIcon from './DetailIcon.svelte';
  import { flushSync, onMount, tick, untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { navigate, navigateBack, navigateOut } from '../lib/navigation';
  import {
    exploreFromPeople,
    parseRoute,
    peopleHref,
    searchHref,
    type Explore,
    type Route,
  } from '../lib/route';
  import {
    clearRecentSearches,
    forgetSearch,
    isRecentSearchStorageEvent,
    readRecentSearches,
    RECENT_SEARCHES_CHANGED,
    rememberSearch,
  } from '../lib/recentSearches';
  let { route, query = '' }: { route: Route; query?: string } = $props();
  /**
   * On People the field finds people and facets there: what is typed stays in People's address (`q=`) instead of
   * opening Search, and Enter still searches titles.
   */
  const onPeople = $derived(route.page === 'people');
  // What the field shows. The route owns the query, and every letter typed reaches it at once (`commit`), so the
  // results follow each letter; this follows the route whenever it changes from somewhere else — Back, a shared
  // link, leaving search. Only the browser's address trails a letter behind, until typing pauses (`Router`).
  let text = $state(untrack(() => query));
  /** A phone's bar: the placeholder says less, to fit. */
  const narrow = new MediaQuery('width <= 759px');
  $effect(() => {
    if (query === untrack(() => text)) return;
    text = query;
  });
  /** `top` returns to the top of the results; a blur must not, or a tap landing on a card loses it. */
  function commit(top = true) {
    if (route.page === 'search') navigate(searchHref(text, explore()), true);
    else if (route.page === 'people') navigate(peopleHref({ ...route, query: text }), true);
    else return;
    if (top) window.scrollTo({ top: 0, behavior: 'instant' });
  }
  // eslint-disable-next-line svelte/prefer-writable-derived -- Focus must expand synchronously within the iPhone tap; route changes reconcile it after navigation.
  let expanded = $state(false);
  let input = $state<HTMLInputElement>();
  let toggle = $state<HTMLButtonElement>();
  let recent = $state<string[]>([]);
  let searchFocused = $state(false);
  /** Escape closed the recent searches; they come back the next time the field is focused. */
  let recentDismissed = $state(false);
  const showRecent = $derived(
    !onPeople && !text.trim() && recent.length > 0 && searchFocused && !recentDismissed,
  );
  // By page, not by route: each letter typed on People is a new route there, and must not fold a phone's field away.
  const page = $derived(route.page);
  $effect(() => {
    expanded = page === 'search';
  });
  /**
   * Search opened fresh — loaded, reloaded, or come back to from another tab — puts the cursor in the field, so it
   * is plain where to type. Only with a mouse or trackpad: on a touch screen it would raise the keyboard over the
   * grid (and iOS refuses it without a tap anyway), and the field is already drawn open there. Never when focus is
   * already somewhere on the page, which is how Back from a title arrives: it keeps its place.
   */
  onMount(() => {
    recent = readRecentSearches();
    const recentChanged = (event: Event) => {
      recent = (event as CustomEvent<string[]>).detail;
    };
    const storageChanged = (event: StorageEvent) => {
      if (isRecentSearchStorageEvent(event)) recent = readRecentSearches();
    };
    window.addEventListener(RECENT_SEARCHES_CHANGED, recentChanged);
    window.addEventListener('storage', storageChanged);
    const focusIfIdle = () => {
      if (route.page !== 'search') return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      input?.focus({ preventScroll: true });
    };
    const shown = () => {
      if (document.visibilityState === 'visible') focusIfIdle();
    };
    const fine = matchMedia('(pointer: fine)').matches;
    if (fine) {
      // After the route has opened the field, where it is drawn only on /search.
      void tick().then(focusIfIdle);
      document.addEventListener('visibilitychange', shown);
    }
    return () => {
      if (fine) document.removeEventListener('visibilitychange', shown);
      window.removeEventListener(RECENT_SEARCHES_CHANGED, recentChanged);
      window.removeEventListener('storage', storageChanged);
    };
  });
  function openSearch() {
    // Focus during the tap itself so iPhone browsers open the keyboard.
    flushSync(() => {
      expanded = true;
    });
    input?.focus({ preventScroll: true });
  }
  function closeSearch() {
    flushSync(() => {
      expanded = false;
    });
    input?.blur();
    toggle?.focus({ preventScroll: true });
    if (onPeople && text) {
      text = '';
      commit(false);
    }
    // The address, not just the prop: opening and cancelling within one tick — which a fast tap does, and a
    // test does reliably — leaves the route prop still showing the page search was opened from, and Cancel
    // would do nothing at all. Out of Search in one step, however many chips were picked in it.
    if (searching()) navigateOut();
  }
  const searching = () =>
    route.page === 'search' || parseRoute(location.pathname + location.search).page === 'search';
  /** What Explore is browsing: a query is typed over it, and clearing the query returns to it. */
  const explore = (): Explore =>
    route.page === 'search' ? { type: route.type, chips: route.chips } : {};
  function searchChanged() {
    // Arriving at search is a navigation, and happens at once. Every letter after that rewrites the same entry,
    // or Back would walk the spelling of what was typed instead of returning to the page it started from.
    if (route.page !== 'search' && !onPeople) {
      navigate(searchHref(text));
      return;
    }
    commit();
  }
  function submitted(event: SubmitEvent) {
    event.preventDefault();
    if (text.trim().length >= 2) recent = rememberSearch(text);
    if (route.page === 'search') commit();
    else if (route.page === 'people') {
      // Enter searches titles, as it does everywhere else, taking the type and title facets along.
      navigate(searchHref(text, exploreFromPeople(route)));
    } else navigate(searchHref(text, explore()));
    input?.blur();
  }
  function useRecent(value: string) {
    recent = rememberSearch(value);
    text = value;
    // Focus opens Search before Router's `route` prop necessarily catches up. Read the address it already changed
    // instead, so an immediate tap on a recent item cannot be reset to the empty Search route.
    const here = parseRoute(location.pathname + location.search);
    const context: Explore = here.page === 'search' ? { type: here.type, chips: here.chips } : {};
    navigate(searchHref(value, context), true);
    window.scrollTo({ top: 0, behavior: 'instant' });
    input?.focus({ preventScroll: true });
  }
  function removeRecent(value: string) {
    recent = forgetSearch(value);
    input?.focus({ preventScroll: true });
  }
  function clearRecent() {
    recent = clearRecentSearches();
    input?.focus({ preventScroll: true });
  }
  function moveRecent(event: KeyboardEvent, index: number) {
    if (event.key === 'Escape') {
      event.preventDefault();
      escaped();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const choices = [
      ...document.querySelectorAll<HTMLButtonElement>('#recent-searches .recent-query'),
    ];
    if (event.key === 'ArrowUp' && index === 0) input?.focus({ preventScroll: true });
    else
      choices[
        Math.max(0, Math.min(choices.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
      ]?.focus();
  }
  /** ArrowDown from the field: into what it found — the first of the Browse row, or the first result. */
  async function intoResults() {
    await tick();
    const recentQuery = document.querySelector<HTMLElement>('#nav-search .recent-query');
    if (recentQuery && recentQuery.getClientRects().length) {
      recentQuery.focus({ preventScroll: false });
      return;
    }
    const page = '[data-route-page][data-active="true"]';
    document
      .querySelector<HTMLElement>(`${page} .browse button, ${page} .grid a`)
      ?.focus({ preventScroll: false });
  }
  /**
   * Esc closes the recent searches first, as it closes any list opened over the page; then empties a typed query,
   * back to Explore; and leaves search only from there.
   */
  function escaped() {
    if (showRecent) {
      recentDismissed = true;
      input?.focus({ preventScroll: true });
      return;
    }
    if (!text.trim() || (route.page !== 'search' && !onPeople)) {
      closeSearch();
      return;
    }
    text = '';
    commit();
  }
  /**
   * The strip, and what a phone does with it.
   *
   * Five labels of text need about 285px, and at 390px the strip has 236px to put them in — so they were
   * already running off its right edge, scrolling with the scrollbar hidden and nothing to say they were
   * there. `Home` gives way below 760px: the mark beside it is already a link to the same place, 48px wide
   * and always visible, and it is the one tab whose address differs from the canonical one.
   *
   * `Settings` keeps its mark and hides its word. The text stays in the DOM, so the name a screen reader
   * reads and a test looks for is unchanged — an `aria-label` swap would have quietly broken both.
   *
   * The mark is sliders rather than a cog. A cog is its teeth, and at 18px with this stroke there is no room
   * to draw them: the first attempt was a small disc with long rays, which is a sun. Three rails with their
   * knobs offset survives the size, and settings as adjustments is a fair reading of what the page is.
   */
  const tabs = [
    { page: 'library', label: 'Home', icon: undefined },
    { page: 'movies', label: 'Movies', icon: undefined },
    { page: 'series', label: 'Series', icon: undefined },
    { page: 'watchlist', label: 'Watchlist', icon: undefined },
    { page: 'settings', label: 'Settings', icon: 'sliders' },
  ] as const;
</script>

<div class="bar-anchor">
  <header class="bar glass" class:searching={expanded} class:people={onPeople}>
    <div class="leading">
      <a class="brand" href="/" aria-label="Den home"
        ><img src={icon} width="54" height="32" alt="" /></a
      >
      {#if route.page === 'title' || route.page === 'person' || route.page === 'search'}
        <button class="back" type="button" onclick={navigateBack} aria-label="Back">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
            ><path d="m14 5-7 7 7 7" /></svg
          >
          Back
        </button>
      {/if}
    </div>
    <!-- Navigation and search belong to anyone reading the page, paired or not. Hiding them behind a library
       left a guest on Home with no way to reach Movies, Series or Settings — which is also where pairing is —
       and no way to search, though den-edge lends a keyless browser the key that search needs. -->
    <form
      class="search"
      role="search"
      id="nav-search"
      onsubmit={submitted}
      onfocusin={() => (searchFocused = true)}
      onfocusout={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
          searchFocused = false;
          recentDismissed = false;
        }
      }}
    >
      <svg class="search-glyph" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
        ><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg
      >
      <input
        name="search"
        bind:this={input}
        bind:value={text}
        type="search"
        aria-label={onPeople
          ? 'Search people, nationalities, roles…'
          : 'Search titles, people, moods, languages…'}
        placeholder={onPeople
          ? narrow.current
            ? 'People, nationalities, roles…'
            : 'Search people, nationalities, roles…'
          : narrow.current
            ? 'Titles, people, moods…'
            : 'Search titles, people, moods, languages…'}
        autocomplete="off"
        aria-controls={showRecent ? 'recent-searches' : undefined}
        enterkeyhint="search"
        onfocus={() => {
          if (route.page !== 'search' && !onPeople) navigate(searchHref(text));
        }}
        oninput={searchChanged}
        onkeydown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            escaped();
          } else if (event.key === 'ArrowDown' && (route.page === 'search' || onPeople)) {
            event.preventDefault();
            void intoResults();
          }
        }}
      />
      <button class="cancel" type="button" onclick={closeSearch}>Cancel</button>
      {#if showRecent}
        <span class="recent-status" role="status"
          >Recent searches available. Press Down Arrow to review.</span
        >
        <!-- Pressing in the list keeps the field focused. iOS Safari doesn't focus a tapped button, so the field's
             blur had nowhere to go, the bar took search as left, and the list was gone before the tap's click.
             The handler only holds focus; the list's buttons are what is interactive. -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          id="recent-searches"
          class="recent"
          role="group"
          aria-label="Recent searches"
          onmousedown={(event) => event.preventDefault()}
        >
          <div class="recent-heading">
            <span>Recent searches</span><button type="button" onclick={clearRecent}>Clear</button>
          </div>
          <ul>
            {#each recent as value, index (value.toLocaleLowerCase())}
              <li>
                <button
                  class="recent-query"
                  type="button"
                  onclick={() => useRecent(value)}
                  onkeydown={(event) => moveRecent(event, index)}
                  ><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"
                    ><path d="M12 7v5l3 2" /><circle cx="12" cy="12" r="8" /></svg
                  ><span>{value}</span></button
                ><button
                  class="recent-remove"
                  type="button"
                  aria-label={`Remove ${value} from recent searches`}
                  onclick={() => removeRecent(value)}>×</button
                >
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </form>
    <nav aria-label="Main navigation">
      {#each tabs as tab (tab.page)}
        <a
          href="/{tab.page}"
          class:home={tab.page === 'library'}
          aria-current={route.page === tab.page ? 'page' : undefined}
        >
          {#if tab.icon}<DetailIcon name={tab.icon} /><span class="label">{tab.label}</span>
          {:else}{tab.label}{/if}
        </a>
      {/each}
    </nav>
    <button
      class="search-toggle"
      type="button"
      aria-label="Search"
      aria-expanded={expanded}
      aria-controls="nav-search"
      onclick={openSearch}
      bind:this={toggle}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"
        ><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg
      >
    </button>
  </header>
</div>

<style>
  .bar-anchor {
    display: contents;
  }

  .bar {
    position: fixed;
    top: max(12px, env(safe-area-inset-top));
    right: var(--gutter);
    left: var(--gutter);
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 46px;
    padding: 6px 12px;
    border-radius: 999px;
  }

  .leading {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .brand {
    display: flex;
    flex-shrink: 0;
    width: 54px;
    height: 32px;
    overflow: hidden;
  }

  .brand img {
    display: block;
    width: 54px;
    height: 32px;
    object-fit: contain;
    transform: translateY(-2px) scale(2.2);
  }

  .back {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 32px;
    padding: 0 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--fg);
    cursor: pointer;
  }

  .back:hover {
    background: rgb(255 255 255 / 0.08);
  }

  .back svg {
    fill: none;
    stroke: currentcolor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .search {
    position: relative;
    display: flex;
    align-items: center;

    /* Pushed to the right rather than filling the bar, so it sits just before the menu instead of leaving
       the links stranded at the far edge with a gulf between. Mobile puts `flex` back when it takes over
       the whole bar. */
    margin-left: auto;
    gap: 8px;
    min-width: 140px;
    max-width: 360px;
    height: 32px;
    border-radius: 999px;
    padding: 0 10px;
    background: rgb(255 255 255 / 0.06);
  }

  .search:focus-within {
    outline: 1px solid var(--muted);
  }

  /* On search and People, at a laptop's width and up, room for the whole placeholder: it says what can be searched. */
  @media (width >= 1100px) {
    .searching .search,
    .people .search {
      flex: 0 1 400px;
      max-width: 420px;
    }
  }

  .search-glyph {
    flex-shrink: 0;
    color: var(--muted);
  }

  .search input {
    min-width: 0;
    width: 100%;
    padding: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--fg);
    font-size: 16px;
  }

  .search input::placeholder {
    color: var(--muted);
  }

  .search-toggle,
  .cancel {
    display: none;
    border: 0;
    background: none;
    color: var(--fg);
    cursor: pointer;
  }

  .search svg,
  .search-toggle svg {
    fill: none;
    stroke: currentcolor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .recent {
    position: absolute;
    top: calc(100% + 10px);
    right: 0;
    left: 0;
    min-width: min(360px, calc(100vw - 2 * var(--gutter)));
    padding: 8px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--card);
    box-shadow: 0 16px 40px rgb(0 0 0 / 0.35);
  }

  .recent-status {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .recent-heading,
  .recent li {
    display: flex;
    align-items: center;
  }

  .recent-heading {
    justify-content: space-between;
    padding: 4px 8px 6px;
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
  }

  .recent ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .recent li {
    border-radius: 8px;
  }

  .recent li:hover,
  .recent li:focus-within {
    background: rgb(255 255 255 / 0.07);
  }

  .recent button {
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .recent-heading button {
    padding: 3px 5px;
    color: var(--muted);
    font-size: 12px;
  }

  .recent-query {
    display: flex;
    align-items: center;
    gap: 9px;
    flex: 1;
    min-width: 0;
    min-height: 38px;
    padding: 0 8px;
    text-align: left;
  }

  .recent-query svg {
    flex-shrink: 0;
    fill: none;
    stroke: var(--muted);
    stroke-width: 1.7;
  }

  .recent-query span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .recent-remove {
    flex-shrink: 0;
    width: 34px;
    height: 34px;
    padding: 0;
    color: var(--muted) !important;
    font-size: 20px !important;
  }

  .recent button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  nav {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    gap: clamp(12px, 3vw, 24px);
  }

  /* A target rather than a bare line of text: these had no padding at all, so "Home" was about 37 by 20
     pixels — under the 24px minimum, and a long way from the 44px this app uses everywhere else. 34px is
     what the 46px bar can give once its own padding is taken out. */
  nav a {
    display: grid;
    grid-auto-flow: column;
    place-items: center;
    gap: 6px;
    min-height: 34px;
    padding-inline: 6px;
    color: var(--muted);
    font-weight: 600;
    text-decoration: none;
    white-space: nowrap;
  }

  nav a[aria-current='page'] {
    color: var(--fg);
  }

  nav a :global(svg) {
    width: 18px;
    height: 18px;
  }

  /* Every other control in this app shows where the keyboard is; this bar showed nothing at all. */
  nav a:focus-visible,
  .brand:focus-visible,
  .search-toggle:focus-visible,
  .back:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* Between the phone layout and a wide window, five tabs of text at desktop spacing need about 450px. At 820px
     that left the search field at its 140px floor and, with Back showing, ran the strip off the bar's right
     edge. Here the tabs take the phone's economies — no `Home` (the mark is that link), `Settings` as its
     mark — and a tighter gap, which gives the field about 280px on every page. */
  @media (760px <= width <= 1099px) {
    nav {
      gap: 16px;
    }

    nav a.home {
      display: none;
    }

    .label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  }

  @media (width <= 759px) {
    /* A focused input must not remain under `position: fixed` on iOS: WebKit can paint its caret at the
       document-space coordinate after the keyboard changes the visual viewport. A zero-height sticky anchor
       keeps the same viewport geometry without leaving any fixed ancestor above the native editing control. */
    .bar-anchor {
      position: sticky;
      top: max(12px, env(safe-area-inset-top));
      z-index: 10;
      display: block;
      height: 0;
    }

    .bar {
      position: absolute;
      top: 0;
      gap: 8px;
    }

    .back {
      display: none;
    }

    .brand,
    .brand img {
      width: 48px;
    }

    .search {
      display: none;
    }

    .search-toggle {
      display: grid;
      place-items: center;
      flex-shrink: 0;
      width: 32px;
      height: 32px;
      padding: 0;
    }

    /* Five tabs of text do not fit beside the mark and the search button at 320px — they overflowed the bar
       and pushed the search button off its right edge. The strip shrinks and scrolls instead, so every tab is
       still reachable and the bar's own controls stay inside it. */
    nav {
      flex-shrink: 1;
      min-width: 0;
      margin-left: auto;
      overflow-x: auto;
      gap: clamp(8px, 2vw, 12px);
      font-size: 14px;
      scrollbar-width: none;
    }

    nav::-webkit-scrollbar {
      display: none;
    }

    /* The mark to the left of this is already a link to the same page, and a wider target than the word was. */
    nav a.home {
      display: none;
    }

    /* Read out at every width, drawn only where there is room — the same shape the title actions and the
       watchlist page use. The cog carries it here, and the word stays in the DOM, so nothing that looks for
       "Settings" by name stops finding it. */
    .label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }

    .searching .leading,
    .searching nav,
    .searching .search-toggle {
      display: none;
    }

    .searching .search {
      display: flex;
      flex: 1;
      max-width: none;
      padding: 0;
      background: none;
    }

    .recent {
      top: calc(100% + 12px);
      right: 0;
      left: 0;
      min-width: 0;
    }

    .searching .search:focus-within {
      outline: none;
    }

    .cancel {
      display: block;
      flex-shrink: 0;
      height: 32px;
      padding: 0 2px 0 8px;
      font-size: 14px;
    }
  }

  @media (width <= 359px) {
    .bar {
      gap: 6px;
      padding-inline: 8px;
    }

    nav {
      gap: 4px;
      font-size: 13px;
    }

    .search-toggle {
      width: 28px;
    }
  }
</style>
