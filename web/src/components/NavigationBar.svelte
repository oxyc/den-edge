<script lang="ts">
  import icon from '../assets/den-mark.png';
  import DetailIcon from './DetailIcon.svelte';
  import { flushSync, untrack } from 'svelte';
  import { navigate, navigateBack } from '../lib/navigation';
  import { parseRoute, searchHref, type Route } from '../lib/route';
  let { route, query = '' }: { route: Route; query?: string } = $props();
  // What the field shows. The address owns the query, so this follows it whenever it changes from somewhere
  // else — Back, a shared link, leaving search — and leads it only while someone is typing.
  let text = $state(untrack(() => query));
  $effect(() => {
    if (query !== untrack(() => text)) text = query;
  });
  // eslint-disable-next-line svelte/prefer-writable-derived -- Focus must expand synchronously within the iPhone tap; route changes reconcile it after navigation.
  let expanded = $state(false);
  let input = $state<HTMLInputElement>();
  let toggle = $state<HTMLButtonElement>();
  $effect(() => {
    expanded = route.page === 'search';
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
    // The address, not just the prop: opening and cancelling within one tick — which a fast tap does, and a
    // test does reliably — leaves the route prop still showing the page search was opened from, and Cancel
    // would do nothing at all.
    if (searching()) navigateBack();
  }
  const searching = () =>
    route.page === 'search' || parseRoute(location.pathname + location.search).page === 'search';
  function searchChanged() {
    // Arriving at search is a navigation; every letter after that rewrites the same entry, or Back would walk
    // the spelling of what was typed instead of returning to the page the search started from.
    const searching = route.page === 'search';
    navigate(searchHref(text), searching);
    if (searching) window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function submitted(event: SubmitEvent) {
    event.preventDefault();
    navigate(searchHref(text), route.page === 'search');
    input?.blur();
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
  <header class="bar glass" class:searching={expanded}>
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
    <form class="search" role="search" id="nav-search" onsubmit={submitted}>
      <svg class="search-glyph" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
        ><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg
      >
      <input
        name="search"
        bind:this={input}
        bind:value={text}
        type="search"
        aria-label="Search movies, series and people"
        placeholder="Search movies, series and people"
        autocomplete="off"
        enterkeyhint="search"
        onfocus={() => {
          if (route.page !== 'search') navigate(searchHref(text));
        }}
        oninput={searchChanged}
        onkeydown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            closeSearch();
          }
        }}
      />
      <button class="cancel" type="button" onclick={closeSearch}>Cancel</button>
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
