<!-- What a page shows while its screen's chunk loads (`screens.svelte.ts`), and when it could not: a spinner that
     never ends would say the page is on its way when nothing is fetching it. -->
<script lang="ts">
  import Loading from './Loading.svelte';
  import { swapFailedScreen } from '../lib/release';

  let {
    screen,
    page = true,
  }: {
    screen: { failed: boolean; load(): Promise<void> };
    /** Over the whole page (`Loading`'s `page`), or in place, as inside a dialog. */
    page?: boolean;
  } = $props();

  // The screen the person opened is a file of a release den-edge has replaced: loading the page onto the new
  // release is what brings it, and there is nothing on screen to lose.
  $effect(() => {
    if (screen.failed) swapFailedScreen();
  });
</script>

{#if screen.failed}
  <p class="note">Couldn’t load this page. Check that this device is online.</p>
  <button class="more" onclick={() => void screen.load()}>Try again</button>
{:else}
  <Loading label="Loading" {page} />
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
