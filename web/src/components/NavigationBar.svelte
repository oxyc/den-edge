<script lang="ts">
  import icon from '../assets/den-mark.png';
  import { flushSync } from 'svelte';
  import { navigate, navigateBack } from '../lib/navigation';
  import type { Route } from '../lib/route';
  let {
    route,
    paired,
    query = $bindable(''),
  }: { route: Route; paired: boolean; query?: string } = $props();
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
    if (route.page === 'search' || location.hash === '#search') navigateBack();
  }
  function searchChanged() {
    if (route.page === 'search') window.scrollTo({ top: 0, behavior: 'instant' });
    else navigate('#search');
  }
  function submitted(event: SubmitEvent) {
    event.preventDefault();
    navigate('#search');
    input?.blur();
  }
  const tabs = [
    { page: 'library', label: 'Home' },
    { page: 'movies', label: 'Movies' },
    { page: 'series', label: 'Series' },
    { page: 'settings', label: 'Settings' },
  ] as const;
</script>

<header class="bar glass" class:searching={expanded}>
  <div class="leading">
    <a class="brand" href="#library" aria-label="Den home"
      ><img src={icon} width="54" height="32" alt="" /></a
    >
    {#if paired && (route.page === 'title' || route.page === 'person' || route.page === 'search')}
      <button class="back" type="button" onclick={navigateBack} aria-label="Back">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
          ><path d="m14 5-7 7 7 7" /></svg
        >
        Back
      </button>
    {/if}
  </div>
  {#if paired}
    <form class="search" role="search" id="nav-search" onsubmit={submitted}>
      <svg class="search-glyph" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
        ><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg
      >
      <input
        bind:this={input}
        bind:value={query}
        type="search"
        aria-label="Search movies, series and people"
        placeholder="Search movies, series and people"
        autocomplete="off"
        enterkeyhint="search"
        onfocus={() => navigate('#search')}
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
        <a href="#{tab.page}" aria-current={route.page === tab.page ? 'page' : undefined}
          >{tab.label}</a
        >
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
  {/if}
</header>

<style>
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
    flex: 1;
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

  nav a {
    color: var(--muted);
    font-weight: 600;
    text-decoration: none;
  }

  nav a[aria-current='page'] {
    color: var(--fg);
  }

  @media (width <= 759px) {
    .back {
      display: none;
    }

    .bar {
      gap: 8px;
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

    nav {
      margin-left: auto;
      gap: clamp(8px, 2vw, 12px);
      font-size: 14px;
    }

    .searching .leading,
    .searching nav,
    .searching .search-toggle {
      display: none;
    }

    .searching .search {
      display: flex;
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
