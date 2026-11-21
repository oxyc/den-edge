<!-- Home's shelf of streaming services (the TV's ServiceRow): the household's own picks, or the ones a visitor is shown
     until there is a library to pick in. It carries the JustWatch credit for the whole row, since what a tile leads to
     is availability data. A settled failure keeps one quiet placeholder so lower rows do not jump. -->
<script lang="ts">
  import { i18n } from '../lib/i18n.svelte';
  import { PAGER_FAILURE } from '../lib/catalog';
  import { capitalizeHeading } from '../lib/headingText';
  import type { ResolvedService } from '../lib/services';
  import { observeNearViewport } from '../lib/nearViewport';
  import type { Service } from '../settings/services';
  import ServiceTile from './ServiceTile.svelte';

  let {
    services,
    heading = 'Services',
    pending = 0,
    empty,
    recovery,
    onretry,
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
    /** A recoverable directory failure. Its action occupies the same tile geometry as loading and empty states. */
    recovery?: 'failed' | 'retrying';
    onretry?: () => void;
    /** A tile is about to be opened (`ServiceTile`): the page behind it can start loading. */
    onintent?: (service: Service, country: string) => void;
    /** Called once when this rail is close enough that its provider directories should start loading. */
    onvisible?: () => void;
  } = $props();
  const localizedHeading = $derived(capitalizeHeading(i18n.phrase(heading), i18n.language));
  let section = $state<HTMLElement>();
  let retryButton = $state<HTMLButtonElement>();
  let restoreRetryFocus = false;

  function retry() {
    restoreRetryFocus = document.activeElement === retryButton;
    onretry?.();
  }

  $effect(() => {
    const state = recovery;
    if (!restoreRetryFocus || state === 'retrying') return;
    requestAnimationFrame(() => {
      (state === 'failed' ? retryButton : section?.querySelector<HTMLElement>('.tile'))?.focus();
      restoreRetryFocus = false;
    });
  });

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

{#if services.length || pending || empty || recovery}
  <section
    class="row services-row"
    aria-label={localizedHeading}
    data-layout-state={pending || recovery === 'retrying' ? 'pending' : 'settled'}
    bind:this={section}
  >
    <h2>{localizedHeading}</h2>
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
        {/if}
      {/each}
      {#if recovery || (!services.length && empty)}
        <span class="hold empty">
          {#if recovery}
            <button
              class="plate retry"
              type="button"
              aria-label={i18n.phrase('Try again')}
              aria-disabled={recovery === 'retrying'}
              bind:this={retryButton}
              onclick={retry}>↻</button
            >
          {:else}
            <span class="plate" aria-hidden="true">—</span>
          {/if}
          <span role="status"
            >{i18n.phrase(
              recovery === 'retrying' ? 'Trying again…' : (empty ?? PAGER_FAILURE[3]),
            )}</span
          >
        </span>
      {/if}
    </div>
  </section>
  <p class="justwatch-credit credit">Streaming availability by JustWatch</p>
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
    padding: 0 0 8px;
    overflow-x: auto;
    scroll-snap-type: x proximity;
    scroll-padding-inline: 0;
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

    /* This is the exact name line that replaces it. TV promotes service names to ten-foot type, so retaining the
       browser's 14px fallback here let a provider result grow the rail after lower shelves had taken their place. */
    font-size: var(--service-name-size, 14px);
  }

  .hold > :last-child {
    /* ServiceTile's name and optional country share one line. The unavailable copy must obey the same vertical
       geometry, while retaining its complete localized message instead of clipping it to a service tile. */
    white-space: nowrap;
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
    width: max-content;
    min-width: var(--tile-w);
    justify-items: start;
    color: var(--muted);
  }

  .empty .plate {
    width: var(--tile-w);
    font-size: 28px;
  }

  .retry {
    appearance: none;

    /* Reduced Tizen gives buttons border-box sizing while the reserved span plate is content-box. Keep the same
       two-border geometry instead of shrinking the settled/retrying row by 2px when the placeholder is replaced. */
    box-sizing: content-box;
    padding: 0;
    color: inherit;
  }

  .retry:focus-visible {
    outline: var(--ring-width) solid var(--focus-ring);
    outline-offset: calc(-1 * var(--ring-width));
  }
</style>
