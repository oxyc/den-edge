<script lang="ts">
  import type { ResolvedService } from '../src/lib/services';
  import ServicesRow from '../src/components/ServicesRow.svelte';

  const result = new URL(location.href).searchParams.get('result') ?? 'unavailable';
  let requests = $state(0);
  let admitted = $state(false);
  let retrying = $state(false);
  let settled = $state(false);
  let services = $state.raw<ResolvedService[]>([]);
  const netflix = {
    id: 8,
    name: 'Netflix',
    priority: 1,
    movies: true,
    series: true,
    variants: [],
  };
  const max = {
    id: 1899,
    name: 'Max',
    priority: 2,
    movies: true,
    series: true,
    variants: [],
  };
  const ordinary: ResolvedService[] = [
    { pick: { id: netflix.id, country: 'US' }, service: netflix },
    { pick: { id: max.id, country: 'US' }, service: max },
  ];
  const duplicate: ResolvedService[] = [
    { pick: { id: netflix.id, country: 'US' }, service: netflix },
    { pick: { id: netflix.id, country: 'FI' }, service: netflix },
  ];
  (window as unknown as { replaceServicesWithDuplicate: () => void }).replaceServicesWithDuplicate =
    () => (services = duplicate);

  function admit() {
    if (admitted) return;
    admitted = true;
    requests++;
    queueMicrotask(() => {
      if (result === 'resolved' || result === 'replacement') services = ordinary;
      else if (result === 'duplicate') services = duplicate;
      settled = true;
    });
  }

  function retry() {
    if (retrying) return;
    retrying = true;
    requests++;
  }

  function resolveRetry() {
    services = ordinary;
    retrying = false;
  }
</script>

<p data-requests>{requests}</p>
<button data-resolve-retry hidden onclick={resolveRetry}>Resolve retry</button>
<div aria-hidden="true" style="height: 2400px"></div>
<ServicesRow
  {services}
  pending={settled ? 0 : 2}
  failure={settled && services.length === 0 ? 'Services unavailable' : undefined}
  {retrying}
  onretry={retry}
  onvisible={admit}
/>
