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
    /* Spacing belongs to the surface, not here: this sits under a row on Home and under a brand header on a
       service's page, and a margin tuned for one lands wrong on the other. */
    margin: 0 0 24px;
    color: var(--muted);
    font-size: 12px;
  }
</style>
