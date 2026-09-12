<script lang="ts">
  import { tick } from 'svelte';
  import Library from './Library.svelte';
  import { links } from './lib/links.svelte';
  import { parseRoute } from './lib/route';
  import LinkTV from './LinkTV.svelte';
  import Settings from './Settings.svelte';

  // The links hold this browser's keys, and Safari clears a site's storage after a week unused unless it is
  // installed or the storage is persistent — which would mean pairing again.
  $effect(() => {
    if (links.list.length) void navigator.storage?.persist?.().catch(() => false);
  });

  // Each page is a fragment (`#settings`, `#title/tv/1399`, `#person/287`), so Back returns to the one before.
  let route = $state(parseRoute(location.hash));
  $effect(() => {
    const follow = () => {
      const next = () => (route = parseRoute(location.hash));
      // The browser cross-fades one page into the next where it can (Safari 18, Chrome 111); where it can't, or
      // where the viewer asked for less movement, the page simply changes.
      const start = (document as Document & { startViewTransition?: StartViewTransition }).startViewTransition;
      if (!start || matchMedia('(prefers-reduced-motion: reduce)').matches) return next();
      start.call(document, async () => {
        next();
        await tick();
      });
    };
    addEventListener('hashchange', follow);
    return () => removeEventListener('hashchange', follow);
  });
  /** What a browser with view transitions offers; older ones have none, and are given the plain change instead. */
  type StartViewTransition = (update: () => Promise<void>) => unknown;

  const settings = $derived(route.page === 'settings');
  const tabs = [
    { page: 'library', label: 'Home' },
    { page: 'movies', label: 'Movies' },
    { page: 'series', label: 'Series' },
    { page: 'settings', label: 'Settings' },
  ] as const;
</script>

<header class="bar glass">
  <a class="brand" href="#library">Den</a>
  {#if links.current}
    <nav>
      {#each tabs as tab (tab.page)}
        <a href="#{tab.page}" aria-current={route.page === tab.page ? 'page' : undefined}>{tab.label}</a>
      {/each}
    </nav>
  {/if}
</header>

<main>
  {#if links.current}
    {#key links.current.inboxKey}
      {#if settings}
        <Settings link={links.current} />
      {:else}
        <Library link={links.current} {route} />
      {/if}
    {/key}
  {:else}
    <LinkTV />
  {/if}
</main>

<style>
  /* Fixed rather than sticky: it takes no space in the flow, so a hero can run the full height of the window
     underneath it and the page's own top padding is one stated measure (--bar-space) instead of a sum. */
  .bar {
    position: fixed;
    top: max(12px, env(safe-area-inset-top));
    right: var(--gutter);
    left: var(--gutter);
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    border-radius: 999px;
  }

  .brand {
    color: var(--fg);
    font-weight: 700;
    letter-spacing: 0.02em;
    text-decoration: none;
  }

  nav {
    display: flex;
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

  main {
    max-width: 1400px;
    margin: 0 auto;
    /* Clip, not hidden: a full-bleed child is exactly as wide as the window, and a scrollbar would otherwise
       make that an overflow. Clip leaves the page's own scrolling alone. */
    overflow-x: clip;
    padding: var(--bar-space) var(--gutter) calc(32px + env(safe-area-inset-bottom));
  }
</style>
