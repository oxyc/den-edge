<!-- One of the TV's Settings sections (Connections, Playback, Content, …): a heading, its rows on one plate, and the
     section's footer under it. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    id,
    title,
    footer,
    children,
  }: { id: string; title: string; footer?: string; children: Snippet } = $props();
</script>

<section {id} aria-labelledby="{id}-heading">
  <h2 id="{id}-heading">{title}</h2>
  <div class="plate">{@render children()}</div>
  {#if footer}<p class="footer">{footer}</p>{/if}
</section>

<style>
  section {
    margin-bottom: 40px;
    scroll-margin-top: calc(var(--bar-space) + 64px);
  }

  h2 {
    margin: 0 0 10px;
    font-size: 20px;
  }

  .plate {
    display: grid;
    gap: 6px;
  }

  .footer {
    margin: 8px 16px 0;
    color: var(--muted);
    font-size: 13px;
  }
</style>
