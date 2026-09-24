<!-- What a page shows while its screen's chunk loads (`screens.svelte.ts`), and when it could not: a spinner that
     never ends would say the page is on its way when nothing is fetching it. -->
<script lang="ts">
  import Loading from './Loading.svelte';

  let { screen }: { screen: { failed: boolean; load(): Promise<void> } } = $props();
</script>

{#if screen.failed}
  <p class="note">Couldn’t load this page. Check that this device is online.</p>
  <button class="more" onclick={() => void screen.load()}>Try again</button>
{:else}
  <Loading label="Loading" page />
{/if}

<style>
  .note {
    color: var(--muted);
  }

  .more {
    min-height: 44px;
    padding: 8px 0;
    border: 0;
    background: none;
    color: var(--accent);
    cursor: pointer;
  }

  .more:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }
</style>
