<!-- The Browse row: the facets typed text points at, offered over what it found, each a dashed pill with its kind
     beside it ("Swedish · language"). Picking one is the page's to decide; Search and People both turn the text into
     the pick. -->
<script lang="ts">
  import { KIND, namesExactly, type Chip } from '../lib/explore';

  let {
    chips,
    query,
    onpick,
  }: {
    chips: Chip[];
    /** What was typed: a chip it names whole leads the row, a little heavier. */
    query: string;
    onpick: (chip: Chip) => void;
  } = $props();
</script>

{#if chips.length}
  <div class="browse" role="group" aria-label="Browse">
    {#each chips as chip, at (chip.id)}
      <button
        type="button"
        class="facet"
        class:exact={at === 0 && namesExactly(query, chip)}
        data-chip={chip.id}
        onclick={() => onpick(chip)}
        >{chip.label}<span class="kind">{` · ${chip.kind ?? KIND[chip.group]}`}</span></button
      >
    {/each}
  </div>
{/if}

<style>
  .kind {
    color: var(--muted);
  }

  /* Wrapped on a wide screen, one sideways line on a phone. */
  .browse {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 8px;
    margin: 0 0 16px;
  }

  .facet {
    flex-shrink: 0;
    min-height: 30px;
    padding: 0 10px;
    border: 1px dashed var(--line);
    border-radius: 999px;
    background: transparent;
    color: var(--fg);
    font: inherit;
    font-size: 14px;
    white-space: nowrap;
    cursor: pointer;
  }

  .facet:hover {
    border-color: var(--muted);
  }

  /* The query is this one's whole name: the likeliest meaning, first in the row and its name a little heavier. Its
     border and colours stay its siblings': a solid outline or a fill is what a picked chip wears (the pills over the
     grid, For You in the rail), and this one isn't picked until it is pressed. */
  .facet.exact {
    font-weight: 600;
  }

  .facet:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  @media (width <= 759px) {
    .browse {
      flex-wrap: nowrap;
      margin-inline: calc(-1 * var(--gutter));
      padding-inline: var(--gutter);
      overflow-x: auto;
      scrollbar-width: none;
    }

    .browse::-webkit-scrollbar {
      display: none;
    }
  }
</style>
