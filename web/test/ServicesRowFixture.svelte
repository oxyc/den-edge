<script lang="ts">
  import ServicesRow from '../src/components/ServicesRow.svelte';
  import type { ResolvedService } from '../src/lib/services';

  let requests = $state(0);
  let admitted = $state(false);
  let failed = $state(false);
  let retrying = $state(false);
  let services = $state<ResolvedService[]>([]);

  function admit() {
    if (admitted) return;
    admitted = true;
    requests++;
    // Model a provider refusal: the per-visit admission stays set while the reserved row settles empty.
    queueMicrotask(() => (failed = true));
  }

  function retry() {
    if (retrying) return;
    retrying = true;
    requests++;
  }

  function resolveRetry() {
    services = [
      {
        pick: { id: 8, country: 'FI' },
        service: {
          id: 8,
          name: 'Netflix',
          priority: 1,
          movies: true,
          series: true,
          variants: [],
        },
      },
    ];
    failed = false;
    retrying = false;
  }
</script>

<p data-requests>{requests}</p>
<button data-resolve-retry hidden onclick={resolveRetry}>Resolve retry</button>
<div aria-hidden="true" style="height: 2400px"></div>
<ServicesRow
  {services}
  pending={!admitted || !failed ? 2 : 0}
  failure={failed ? 'Services unavailable' : undefined}
  {retrying}
  onretry={retry}
  onvisible={admit}
/>
