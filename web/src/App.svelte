<script lang="ts">
  import Library from './Library.svelte';
  import { links } from './lib/links.svelte';
  import LinkTV from './LinkTV.svelte';
  import Settings from './Settings.svelte';

  // The links hold this browser's keys, and Safari clears a site's storage after a week unused unless it is
  // installed or the storage is persistent — which would mean pairing again.
  $effect(() => {
    if (links.list.length) void navigator.storage?.persist?.().catch(() => false);
  });

  // Settings is `#settings`, so Back returns to the library. Not a path: `/settings` is den-edge's API.
  const onSettings = () => location.hash === '#settings';
  let settings = $state(onSettings());
  $effect(() => {
    const follow = () => (settings = onSettings());
    addEventListener('hashchange', follow);
    return () => removeEventListener('hashchange', follow);
  });
</script>

<header class="bar glass">
  <a class="brand" href="#library">Den</a>
  {#if links.current}
    <a class="settings" href={settings ? '#library' : '#settings'} aria-current={settings ? 'page' : undefined}>Settings</a>
  {/if}
</header>

<main>
  {#if links.current}
    {#key links.current.inboxKey}
      {#if settings}
        <Settings link={links.current} />
      {:else}
        <Library link={links.current} />
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

  .settings {
    color: var(--muted);
    font-weight: 600;
    text-decoration: none;
  }

  .settings[aria-current='page'] {
    color: var(--fg);
  }

  main {
    max-width: 1400px;
    margin: 0 auto;
    padding: 28px var(--gutter) calc(32px + env(safe-area-inset-bottom));
  }
</style>
