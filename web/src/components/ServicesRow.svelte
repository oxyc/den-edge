<!-- Home's shelf of streaming services (the TV's ServiceRow): the household's own picks, or the ones a visitor is shown
     until there is a library to pick in. It carries the JustWatch credit for the whole row, since what a tile leads to
     is availability data. An empty list draws nothing rather than an empty rail. -->
<script lang="ts">
  import type { ResolvedService } from '../lib/services';
  import type { Service } from '../settings/services';
  import JustWatchCredit from './JustWatchCredit.svelte';
  import ServiceTile from './ServiceTile.svelte';

  let {
    services,
    heading = 'Services',
    onintent,
  }: {
    services: ResolvedService[];
    heading?: string;
    /** A tile is about to be opened (`ServiceTile`): the page behind it can start loading. */
    onintent?: (service: Service, country: string) => void;
  } = $props();

  /** The same service picked in two countries: only then does a tile need to say which one it is. */
  const countries = $derived.by(() => {
    const seen: Record<number, number> = {};
    for (const { service } of services) seen[service.id] = (seen[service.id] ?? 0) + 1;
    return seen;
  });
</script>

{#if services.length}
  <section class="row" aria-label={heading}>
    <h2>{heading}</h2>
    <div class="track">
      {#each services as { pick, service } (`${service.id}@${pick.country}`)}
        <ServiceTile
          {service}
          country={pick.country}
          showCountry={(countries[service.id] ?? 0) > 1}
          onintent={onintent && (() => onintent(service, pick.country))}
        />
      {/each}
    </div>
  </section>
  <JustWatchCredit />
{/if}

<style>
  .row {
    /* Smaller than a poster: a mark is legible well before a poster is, and more of them fit. */
    --tile-w: clamp(96px, 24vw, 120px);

    margin-bottom: 32px;
  }

  h2 {
    margin: 0 0 12px;
    font-size: 20px;
  }

  .track {
    display: flex;
    gap: 14px;
    margin: 0 calc(-1 * var(--gutter));
    padding: 0 var(--gutter) 8px;
    overflow-x: auto;
    scroll-snap-type: x proximity;
    scroll-padding-inline: var(--gutter);
    scrollbar-width: none;
  }

  .track > :global(*) {
    flex: 0 0 auto;
    scroll-snap-align: start;
  }
</style>
