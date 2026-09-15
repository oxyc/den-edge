<!-- One streaming service, as a brand tile (the TV's ServiceCard). Deliberately not a poster: a service is a mark, not
     a 2:3 sheet, and at poster shape the logos float in dead space.

     The logo sits on a faint plate because TMDB's provider logos are app icons — some with a baked-in white square,
     some transparent with a black mark that would otherwise vanish against the page. A service with no logo at all
     falls back to its initials, so a tile is never blank. -->
<script lang="ts">
  import type { Service } from '../settings/services';
  import { serviceHref } from '../lib/route';

  let {
    service,
    country,
    showCountry = false,
  }: {
    service: Service;
    /** The country this tile's catalogue is for; part of its address, not a preference read later. */
    country: string;
    /** Said only when the same service is shown for more than one country, where the name alone is ambiguous. */
    showCountry?: boolean;
  } = $props();

  const initials = $derived(
    service.name
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 2)
      .toUpperCase(),
  );
</script>

<a
  class="tile"
  href={serviceHref(service.id, country, service.name)}
  aria-label={showCountry ? `${service.name}, ${country}` : service.name}
>
  <span class="art">
    {#if service.logoPath}
      <img
        src={`https://image.tmdb.org/t/p/w154${service.logoPath}`}
        alt=""
        loading="lazy"
        decoding="async"
      />
    {:else}
      <span class="initials" aria-hidden="true">{initials}</span>
    {/if}
  </span>
  <span class="name">{service.name}</span>
  {#if showCountry}<span class="country">{country}</span>{/if}
</a>

<style>
  .tile {
    display: grid;
    width: var(--tile-w);
    justify-items: center;
    gap: 8px;
    color: inherit;
    text-decoration: none;
  }

  .art {
    display: grid;
    width: var(--tile-w);
    height: var(--tile-w);
    place-items: center;
    border: 1px solid var(--line);
    border-radius: 18px;
    background: var(--card);
    overflow: hidden;
  }

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .initials {
    font-size: calc(var(--tile-w) * 0.34);
    font-weight: 600;
    color: var(--muted);
  }

  .name {
    max-width: 100%;
    overflow: hidden;
    font-size: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .country {
    margin-top: -6px;
    color: var(--muted);
    font-size: 12px;
  }

  .tile:focus-visible .art {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }
</style>
