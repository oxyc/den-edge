<script lang="ts">
  import ServicesRow from '../src/components/ServicesRow.svelte';

  let requests = $state(0);
  let admitted = $state(false);
  let failed = $state(false);

  function admit() {
    if (admitted) return;
    admitted = true;
    requests++;
    // Model a provider refusal: the per-visit admission stays set while the reserved row settles empty.
    queueMicrotask(() => (failed = true));
  }
</script>

<p data-requests>{requests}</p>
<div aria-hidden="true" style="height: 2400px"></div>
<ServicesRow
  services={[]}
  pending={!admitted || !failed ? 2 : 0}
  empty={failed ? 'Services unavailable' : undefined}
  onvisible={admit}
/>
