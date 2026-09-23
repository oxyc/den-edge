<!-- Explore and People, side by side as the page's heading: the page open is its title, the other beside it, dimmed,
     a link there carrying what both understand (`peopleFromExplore`, `exploreFromPeople`). -->
<script lang="ts">
  let {
    current,
    explore,
    people,
  }: {
    current: 'explore' | 'people';
    /** Where each tab goes. */
    explore: string;
    people: string;
  } = $props();

  const tabs = $derived([
    { id: 'explore', label: 'Explore', href: explore },
    { id: 'people', label: 'People', href: people },
  ]);
</script>

<nav class="tabs" aria-label="Explore or People">
  {#each tabs as tab (tab.id)}
    {#if tab.id === current}
      <h1><a href={tab.href} aria-current="page">{tab.label}</a></h1>
    {:else}
      <a class="other" href={tab.href}>{tab.label}</a>
    {/if}
  {/each}
</nav>

<style>
  .tabs {
    display: flex;
    align-items: baseline;
    gap: 20px;
    margin: 8px 0 16px;
  }

  h1 {
    margin: 0;
  }

  h1,
  .other {
    font-size: 28px;
    font-weight: 700;
    line-height: 1.2;
  }

  a {
    color: var(--fg);
    text-decoration: none;
  }

  .other {
    color: var(--muted);
  }

  .other:hover {
    color: var(--fg);
  }

  a:focus-visible {
    border-radius: 4px;
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
