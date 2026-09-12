<script lang="ts">
  import { fade } from 'svelte/transition';
  import Loading from './Loading.svelte';
  import type { PageSnapshot } from '../lib/pageSnapshot';
  let { snapshot }: { snapshot: PageSnapshot } = $props();
  let frame: HTMLDivElement;
  $effect(() => {
    const copy = snapshot.show();
    // eslint-disable-next-line svelte/no-dom-manipulating -- This effect owns the frozen DOM clone and removes it on cleanup; Svelte owns only the overlay controls.
    frame.prepend(copy);
    return () => copy.remove();
  });
</script>

<div class="overlay" bind:this={frame} out:fade={{ duration: 90 }} data-loading-snapshot>
  <div class="shade"></div>
  <div class="status"><Loading label="Loading page" /></div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 9;
    overflow: hidden;
    background: var(--bg, #0b0b0f);
  }

  .shade {
    position: absolute;
    inset: 0;
    background: rgb(0 0 0 / 0.2);
  }

  .status {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
  }
</style>
