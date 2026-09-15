<!-- Who the availability comes from, said wherever it is shown (the TV's JustWatchCredit).

     TMDB's terms for watch-provider data require the source to be named as JustWatch, and their own guidance puts the
     bar at each surface that shows availability rather than once in an About page. One component owns the wording so
     a change reaches every surface at once. -->
<script lang="ts">
  let { align = 'start' }: { align?: 'start' | 'center' } = $props();
</script>

<p class="credit" style:text-align={align}>Streaming availability by JustWatch</p>

<style>
  .credit {
    margin: -20px 0 28px;
    color: var(--muted);
    font-size: 12px;
  }
</style>
