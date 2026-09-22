<!-- Search's Explore categories (the TV's Explore rail): For You, then atlas's moods, the recipes, the genres, and the
     languages, countries and decades — the first two say what a genre can't, so they lead. Each shows its strongest
     few, and "Show all" the rest, so every kind can be browsed without typing; typed into, the nav field finds them
     too (Search's Browse row).

     - under 1100px, one strip that scrolls sideways — the moods, recipes and genres — and ends in "More…", which
       opens every section in a sheet. One line on a tablet too: wrapped, the lines covered half its screen. Hidden
       while a query is typed: the Browse row is what to pick from then.
     - from 1100px, a rail down the side, as the TV's is.

     What is picked stacks, and leaves its section: the picks are shown above the grid (Search), and these offer only
     what can still be added — `hidden` says which options can't. -->
<script lang="ts">
  import type { Chip, ChipGroup } from '../lib/explore';

  let {
    chips,
    selected,
    hidden = () => false,
    typing = false,
    onchange,
  }: {
    chips: Chip[];
    /** The picked chips' ids, in the order picked. None is For You — unless a query is what's showing. */
    selected: string[];
    /** A query is typed: For You isn't open, though nothing is picked. */
    typing?: boolean;
    /** An option that can't be added to the selection, or would show nothing beside it. */
    hidden?: (id: string) => boolean;
    /** A chip picked or taken out: its id either way. */
    onchange: (id: string) => void;
  } = $props();

  const SECTIONS: [ChipGroup, string][] = [
    ['mood', 'Moods'],
    ['recipe', 'Recipes'],
    ['genre', 'Genres'],
    ['language', 'Languages'],
    ['country', 'Countries'],
    ['decade', 'Decades'],
  ];
  /** The kinds the phone strip samples: the rest wait in the sheet. */
  const STRIP_KINDS: ChipGroup[] = ['mood', 'recipe', 'genre'];
  /** How many of each a section shows unfiltered: the rail's and the sheet's, and the phone strip's. */
  const LIST_FIRST = 8;
  const STRIP_FIRST = 3;

  const forYou = $derived(chips.filter((chip) => chip.group === 'for-you'));
  /** What can still be added: not picked, not hidden. */
  const open = (chip: Chip) => !selected.includes(chip.id) && !hidden(chip.id);
  const sections = $derived(
    SECTIONS.flatMap(([group, heading]) => {
      const inGroup = chips.filter((chip) => chip.group === group && open(chip));
      return inGroup.length ? [{ group, heading, chips: inGroup }] : [];
    }),
  );
  let expanded = $state<Partial<Record<ChipGroup, boolean>>>({});
  /** Each section unfiltered: its first few, or all of them once "Show all" is picked. */
  const listed = () =>
    sections.map((section) => ({
      ...section,
      shown: expanded[section.group] ? section.chips : section.chips.slice(0, LIST_FIRST),
      more: section.chips.length > LIST_FIRST,
    }));

  let sheet = $state<HTMLDialogElement>();

  function choose(id: string) {
    sheet?.close();
    onchange(id);
  }
</script>

{#snippet chip(item: Chip)}
  <button
    type="button"
    class="chip"
    aria-pressed={item.group === 'for-you' && !typing && selected.length === 0}
    data-chip={item.id}
    onclick={() => choose(item.id)}>{item.label}</button
  >
{/snippet}

{#if !typing}
  <nav class="strip" aria-label="Browse by category">
    {#each [...forYou, ...sections
        .filter((s) => STRIP_KINDS.includes(s.group))
        .flatMap((s) => s.chips.slice(0, STRIP_FIRST))] as item (item.id)}
      {@render chip(item)}
    {/each}
    <button
      type="button"
      class="chip more"
      aria-haspopup="dialog"
      onclick={() => {
        sheet?.showModal();
        // The sheet itself, not its first control: focus there would scroll a phone's sheet past its top.
        sheet?.focus();
      }}>More…</button
    >
  </nav>
{/if}

{#snippet sectioned()}
  {#each listed() as section (section.group)}
    <div class="section" role="group" aria-label={section.heading}>
      <h2 class="heading">{section.heading}</h2>
      <div class="list">
        {#each section.shown as item (item.id)}{@render chip(item)}{/each}
      </div>
      {#if section.more}
        <button
          type="button"
          class="toggle"
          aria-expanded={!!expanded[section.group]}
          onclick={() => (expanded[section.group] = !expanded[section.group])}
          >{expanded[section.group] ? 'Show fewer' : `Show all ${section.chips.length} ›`}</button
        >
      {/if}
    </div>
  {/each}
{/snippet}

<nav class="rail" aria-label="Browse by category">
  {#each forYou as item (item.id)}{@render chip(item)}{/each}
  {@render sectioned()}
</nav>

<dialog class="sheet" bind:this={sheet} aria-label="All categories" tabindex="-1">
  <div class="sheet-body">
    <header>
      <h2 class="title">Browse</h2>
      <button type="button" class="done" onclick={() => sheet?.close()}>Done</button>
    </header>
    {@render sectioned()}
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

  /* Inset, so no scrolling parent — the rail, the strip, the sheet — clips the ring. */
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
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

  /* A section, in the rail and in the sheet: its heading, then its chips. */
  .heading {
    margin: 12px 0 8px;
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  /* "Show all": a quiet line of text in the list's own colour, not a control competing with the chips. */
  .toggle {
    align-self: flex-start;
    min-height: 32px;
    margin-top: 4px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .toggle:hover {
    color: var(--fg);
  }

  /* From 1100px: the rail, grouped under headings. It fills its column and no wider: stretched rather than sized
     to its longest label, and a label too long for it ends in an ellipsis rather than pushing it sideways. */
  @media (width >= 1100px) {
    .strip {
      display: none;
    }

    .rail {
      display: flex;
      flex-direction: column;
      align-self: stretch;
      min-width: 0;
      gap: 18px;
    }

    .section,
    .rail .list {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 2px;
      min-width: 0;
    }

    .rail .heading {
      margin: 0 0 4px 12px;
    }

    .rail .chip {
      min-width: 0;
      min-height: 32px;
      padding: 0 12px;
      overflow: hidden;
      border: 0;
      border-radius: 8px;
      background: transparent;
      text-align: left;
      text-overflow: ellipsis;
    }

    .rail .chip:hover {
      background: rgb(255 255 255 / 0.06);
    }

    .rail .chip[aria-pressed='true'] {
      background: rgb(255 255 255 / 0.14);
      color: var(--fg);
    }

    .rail .toggle {
      margin: 0;
      padding: 0 12px;
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
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 16px 0 4px;
    background: var(--bg);
  }

  .title {
    margin: 0;
    font-size: 17px;
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

  @media (width >= 760px) {
    .sheet {
      width: min(640px, 100% - 48px);
      max-height: 80dvh;
      margin: auto;
      border-radius: 18px;
    }
  }
</style>
