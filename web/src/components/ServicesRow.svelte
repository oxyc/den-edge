<!-- Home's shelf of streaming services (the TV's ServiceRow): the household's own picks, or the ones a visitor is shown
     until there is a library to pick in. It carries the JustWatch credit for the whole row, since what a tile leads to
     is availability data. A settled failure keeps one quiet placeholder so lower rows do not jump. -->
<script lang="ts">
  import type { ResolvedService } from '../lib/services';
  import { observeNearViewport } from '../lib/nearViewport';
  import type { Service } from '../settings/services';
  import JustWatchCredit from './JustWatchCredit.svelte';
  import ServiceTile from './ServiceTile.svelte';

  let {
    services,
    heading = 'Services',
    pending = 0,
    empty,
    onintent,
    onvisible,
  }: {
    services: ResolvedService[];
    heading?: string;
    /**
     * How many tiles to hold room for while the services are still being named. The row sits above Home's other rows,
     * and arriving late it pushed all of them down (a layout shift Lighthouse counted).
     */
    pending?: number;
    /** A settled empty directory keeps the reserved row geometry instead of shifting every later shelf upward. */
    empty?: string;
    /** A tile is about to be opened (`ServiceTile`): the page behind it can start loading. */
    onintent?: (service: Service, country: string) => void;
    /** Called once when this rail is close enough that its provider directories should start loading. */
    onvisible?: () => void;
  } = $props();
  let section = $state<HTMLElement>();

  $effect(() => {
    const element = section;
    const reveal = onvisible;
    if (!element || !reveal) return;
    let sent = false;
    return observeNearViewport(
      element,
      (near) => {
        if (!near || sent) return;
        sent = true;
        reveal();
      },
      '300px 0px',
    );
  });

  /** The same service picked in two countries: only then does a tile need to say which one it is. */
  const countries = $derived.by(() => {
    const seen: Record<number, number> = {};
    for (const { service } of services) seen[service.id] = (seen[service.id] ?? 0) + 1;
    return seen;
  });
</script>

{#if services.length || pending || empty}
  <section class="row" aria-label={heading} bind:this={section}>
    <h2>{heading}</h2>
    <div class="track">
      {#each services as { pick, service } (`${service.id}@${pick.country}`)}
        <ServiceTile
          {service}
          country={pick.country}
          showCountry={(countries[service.id] ?? 0) > 1}
          onintent={onintent && (() => onintent(service, pick.country))}
        />
      {:else}
        {#if pending}
          {#each { length: pending }, n (n)}
            <span class="hold" aria-hidden="true"
              ><span class="plate"></span><span>&nbsp;</span></span
            >
          {/each}
        {:else if empty}
          <span class="hold empty"
            ><span class="plate" aria-hidden="true">—</span><span>{empty}</span></span
          >
        {/if}
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

  /* A tile's size before it has a service: its plate, and a line where its name goes (`ServiceTile`). */
  .hold {
    display: grid;
    width: var(--tile-w);
    gap: 8px;
    font-size: 14px;
  }

  .plate {
    display: grid;
    height: var(--tile-w);
    place-items: center;
    border: 1px solid var(--line);
    border-radius: 18px;
    background: var(--card);
  }

  .empty {
    color: var(--muted);
  }

  .empty .plate {
    font-size: 28px;
  }
</style>
