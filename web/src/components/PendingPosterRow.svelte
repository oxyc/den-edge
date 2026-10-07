<!-- The exact portrait shelf geometry Home can paint as soon as projection membership is known. -->
<script lang="ts">
  import PosterRow from './PosterRow.svelte';

  let { heading, count = 6 }: { heading: string; count?: number } = $props();
</script>

<div class="windowed" data-pending-shelf={heading} aria-busy="true">
  <PosterRow {heading}>
    {#each { length: count } as _, index (index)}
      <span class="skeleton" aria-hidden="true"></span>
    {/each}
  </PosterRow>
</div>

<style>
  /* Keep this identical to WindowedPosterRow's portrait wrapper so replacing it needs no shelf layout. */
  .windowed {
    content-visibility: auto;
    contain-intrinsic-block-size: auto calc(clamp(140px, 38vw, 190px) * 1.5 + 127.2px);
  }

  .skeleton {
    contain: strict;
    width: var(--card-w);
    height: calc(var(--card-w) * 1.5 + 47.2px);
    border-radius: 12px;
    background: linear-gradient(var(--card), var(--card)) top / 100% calc(100% - 47.2px) no-repeat;
  }
</style>
