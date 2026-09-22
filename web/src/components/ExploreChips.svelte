<!-- Search's Explore categories (the TV's Explore rail): For You, then atlas's moods, the recipes and the genres — the
     first two say what a genre can't, so they lead. There are far too many to list, so each shows its strongest few:

     - under 1100px, one strip that scrolls sideways and ends in "More…", which opens everything, grouped and
       filterable, in a sheet. One line on a tablet too: wrapped, the lines covered half its screen.
     - from 1100px, a rail down the side, as the TV's is: eight of each, and "Show all" opens the rest in place with
       a filter over them.

     The open chip is always one of those shown, wherever it sits in its list. -->
<script lang="ts">
  import { matchChips, type Chip, type ChipGroup } from '../lib/explore';

  let {
    chips,
    value,
    onchange,
  }: {
    chips: Chip[];
    /** The open chip's id; empty for none, as while a query is typed. */
    value: string;
    onchange: (id: string) => void;
  } = $props();

  const SECTIONS: [ChipGroup, string][] = [
    ['mood', 'Moods'],
    ['recipe', 'Recipes'],
    ['genre', 'Genres'],
  ];
  /** How many of each a section shows before "Show all": the rail's, and the phone strip's. */
  const RAIL_FIRST = 8;
  const STRIP_FIRST = 3;

  const forYou = $derived(chips.filter((chip) => chip.group === 'for-you'));
  const sections = $derived(
    SECTIONS.flatMap(([group, heading]) => {
      const inGroup = chips.filter((chip) => chip.group === group);
      return inGroup.length ? [{ group, heading, chips: inGroup }] : [];
    }),
  );
  /** The first `n`, and the open chip if it sits further down. */
  const first = (list: Chip[], n: number) => {
    const head = list.slice(0, n);
    const open = list.find((chip) => chip.id === value);
    return open && !head.includes(open) ? [...head, open] : head;
  };
  /** All of `list`, or what `text` matches in it. */
  const filtered = (list: Chip[], text: string) => (text.trim() ? matchChips(text, list) : list);

  let expanded = $state<Partial<Record<ChipGroup, boolean>>>({});
  let filters = $state<Partial<Record<ChipGroup, string>>>({});
  let sheet = $state<HTMLDialogElement>();
  let sheetFilter = $state('');
  let strip = $state<HTMLElement>();

  function choose(id: string) {
    sheet?.close();
    onchange(id);
  }

  // The open chip stays in view on the sideways strip — one opened from a link, or kept across a type switch,
  // can otherwise sit off its edge with nothing saying which is open.
  $effect(() => {
    const open = strip?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (open && strip && strip.scrollWidth > strip.clientWidth) {
      const left = open.offsetLeft - strip.clientWidth / 2 + open.offsetWidth / 2;
      strip.scrollTo({ left, behavior: 'instant' });
    }
    void value;
  });
</script>

{#snippet chip(item: Chip)}
  <button
    type="button"
    class="chip"
    aria-pressed={item.id === value}
    data-chip={item.id}
    onclick={() => choose(item.id)}>{item.label}</button
  >
{/snippet}

<nav class="strip" aria-label="Browse by category" bind:this={strip}>
  {#each [...forYou, ...sections.flatMap((s) => first(s.chips, STRIP_FIRST))] as item (item.id)}
    {@render chip(item)}
  {/each}
  <button
    type="button"
    class="chip more"
    aria-haspopup="dialog"
    onclick={() => {
      sheetFilter = '';
      sheet?.showModal();
    }}>More…</button
  >
</nav>

<nav class="rail" aria-label="Browse by category">
  {#each forYou as item (item.id)}{@render chip(item)}{/each}
  {#each sections as section (section.group)}
    <div class="section" role="group" aria-label={section.heading}>
      <span class="heading">{section.heading}</span>
      {#if expanded[section.group]}
        <input
          class="filter"
          type="search"
          placeholder="Filter {section.heading.toLowerCase()}"
          aria-label="Filter {section.heading.toLowerCase()}"
          bind:value={filters[section.group]}
        />
        {#each filtered(section.chips, filters[section.group] ?? '') as item (item.id)}
          {@render chip(item)}
        {/each}
        <button
          type="button"
          class="toggle"
          onclick={() => {
            expanded[section.group] = false;
            filters[section.group] = '';
          }}>Show fewer</button
        >
      {:else}
        {#each first(section.chips, RAIL_FIRST) as item (item.id)}{@render chip(item)}{/each}
        {#if section.chips.length > RAIL_FIRST}
          <button type="button" class="toggle" onclick={() => (expanded[section.group] = true)}
            >Show all {section.chips.length}</button
          >
        {/if}
      {/if}
    </div>
  {/each}
</nav>

<dialog class="sheet" bind:this={sheet} aria-label="All categories">
  <div class="sheet-body">
    <header>
      <input
        class="filter"
        type="search"
        placeholder="Filter moods, recipes and genres"
        aria-label="Filter categories"
        bind:value={sheetFilter}
      />
      <button type="button" class="done" onclick={() => sheet?.close()}>Done</button>
    </header>
    {#each sections as section (section.group)}
      {@const list = filtered(section.chips, sheetFilter)}
      {#if list.length}
        <section aria-label={section.heading}>
          <h2>{section.heading}</h2>
          <div class="wrap">
            {#each list as item (item.id)}{@render chip(item)}{/each}
          </div>
        </section>
      {/if}
    {/each}
  </div>
</dialog>

<style>
  .chip {
    flex-shrink: 0;
    min-height: 34px;
    padding: 0 14px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--card);
    color: var(--muted);
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
  }

  .chip:hover {
    color: var(--fg);
  }

  .chip[aria-pressed='true'] {
    border-color: transparent;
    background: var(--fg);
    color: var(--bg);
  }

  .more {
    border-style: dashed;
    color: var(--fg);
  }

  .filter {
    width: 100%;
    min-height: 34px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--card);
    color: var(--fg);
    font: inherit;
    font-size: 16px;
  }

  button:focus-visible,
  .filter:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* Under 1100px: one line, sideways, as wide as the column it sits in rather than as its chips. */
  .strip {
    display: flex;
    align-self: stretch;
    min-width: 0;
    gap: 8px;
    margin-inline: calc(-1 * var(--gutter));
    padding: 4px var(--gutter) 8px;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .strip::-webkit-scrollbar {
    display: none;
  }

  .rail {
    display: none;
  }

  /* From 1100px: the rail, grouped under headings, each group its first eight until it is opened. */
  @media (width >= 1100px) {
    .strip {
      display: none;
    }

    .rail {
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    .section {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 2px;
    }

    .heading {
      margin: 0 0 4px 12px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .rail .filter {
      margin-bottom: 4px;
      font-size: 14px;
    }

    .rail .chip {
      min-height: 32px;
      padding: 0 12px;
      border: 0;
      border-radius: 8px;
      background: transparent;
      text-align: left;
    }

    .rail .chip:hover {
      background: rgb(255 255 255 / 0.06);
    }

    .rail .chip[aria-pressed='true'] {
      background: rgb(255 255 255 / 0.14);
      color: var(--fg);
    }

    .toggle {
      align-self: flex-start;
      min-height: 28px;
      padding: 0 12px;
      border: 0;
      background: none;
      color: var(--accent);
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
  }

  /* The sheet: from the bottom on a phone, where the thumb is; a panel in the middle from 760px. */
  .sheet {
    width: 100%;
    max-width: 100%;
    max-height: 85dvh;
    margin: auto 0 0;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 18px 18px 0 0;
    background: var(--bg);
    color: var(--fg);
  }

  .sheet::backdrop {
    background: rgb(0 0 0 / 0.6);
  }

  .sheet-body {
    padding: 0 16px calc(16px + env(safe-area-inset-bottom));
  }

  .sheet header {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    gap: 10px;
    padding: 16px 0 12px;
    background: var(--bg);
  }

  .done {
    flex-shrink: 0;
    padding: 0 6px;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .sheet h2 {
    margin: 12px 0 8px;
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .wrap {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  @media (width >= 760px) {
    .sheet {
      width: min(640px, 100% - 48px);
      max-height: 80dvh;
      margin: auto;
      border-radius: 18px;
    }
  }
</style>
