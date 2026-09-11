<script lang="ts">
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
    const follow = () => (route = parseRoute(location.hash));
    addEventListener('hashchange', follow);
    return () => removeEventListener('hashchange', follow);
  });
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
  .bar {
    position: sticky;
    top: max(12px, env(safe-area-inset-top));
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 12px var(--gutter) 0;
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
    padding: 28px var(--gutter) calc(32px + env(safe-area-inset-bottom));
  }
</style>
