<script lang="ts">
  // A service page on its own (`?page`), or Home's service shelf with the prime Home wires to it.
  import ServicePage from '../src/components/ServicePage.svelte';
  import ServicesRow from '../src/components/ServicesRow.svelte';
  import { primeServicePage } from '../src/lib/services';
  import '../src/app.css';

  const page = new URLSearchParams(location.search).has('page');
  const netflix = {
    id: 8,
    name: 'Netflix',
    logoPath: '/netflix.jpg',
    priority: 1,
    movies: true,
    series: false,
    variants: [],
  };
</script>

<main style="padding:var(--bar-space) var(--gutter)">
  {#if page}
    <ServicePage id={8} country="US" tmdbKey="fixture-key" atlas="/atlas" shown={() => true} />
  {:else}
    <ServicesRow
      services={[{ pick: { id: 8, country: 'US' }, service: netflix }]}
      onintent={(service, country) => primeServicePage(service, country, 'fixture-key', '/atlas')}
    />
  {/if}
</main>
