<!-- Search's Explore categories (the TV's Explore rail): For You, then atlas's moods, the recipes, the genres, and the
     languages, countries, decades and rating floors — the first two say what a genre can't, so they lead. Each shows its strongest
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
    ['rating', 'Rating'],
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
  /** The sheet's sections: For You under a heading of its own, then the rail's. */
  const sheetSections = $derived([
    ...(forYou.length
      ? [{ group: 'for-you' as ChipGroup, heading: 'For You', chips: forYou }]
      : []),
    ...sections,
  ]);
  let expanded = $state<Partial<Record<ChipGroup, boolean>>>({});
  /** Each section unfiltered: its first few, or all of them once "Show all" is picked. */
  const listed = () =>
    sections.map((section) => ({
      ...section,
      shown: expanded[section.group] ? section.chips : section.chips.slice(0, LIST_FIRST),
      more: section.chips.length > LIST_FIRST,
    }));

  let sheet = $state<HTMLDialogElement>();
  /** The sheet's sections opened out of their one sideways row into a wrapped grid, by "All ›". */
  let spread = $state<Partial<Record<ChipGroup, boolean>>>({});
  /**
   * The sheet holds a history entry of its own while open, so Back closes it as it would any sheet on a phone. It
   * copies the entry under it, which is what the Router reads, so the Router sees the same page either side of it.
   */
  let entry = false;
  /** What to do once the sheet's entry is gone: a pick navigates only then, so no stale entry is left behind it. */
  let afterClose: (() => void) | undefined;

  function openSheet() {
    spread = {};
    sheet?.showModal();
    // The sheet itself, not its first control: focus there would scroll a phone's sheet past its top.
    sheet?.focus();
    history.pushState(history.state, '');
    entry = true;
  }

  function closeSheet(then?: () => void) {
    if (entry) {
      afterClose = then;
      history.back();
    } else {
      sheet?.close();
      then?.();
    }
  }

  $effect(() => {
    const left = () => {
      if (!entry) return;
      entry = false;
      sheet?.close();
      const then = afterClose;
      afterClose = undefined;
      then?.();
    };
    window.addEventListener('popstate', left);
    return () => window.removeEventListener('popstate', left);
  });

  /** Escape closes the dialog itself; its entry goes with it. */
  function closed() {
    if (entry) closeSheet();
  }

  function choose(id: string) {
    if (sheet?.open) closeSheet(() => onchange(id));
    else onchange(id);
  }

  /**
   * Dragged down by its handle or header, the sheet follows the finger, and far enough closes it. A gesture rather
   * than a control — ✕, Escape and Back close it too — so it is listened for here, not given a role.
   */
  let grab = $state<HTMLElement>();
  let drag = $state(0);
  const DRAG_CLOSE = 80;
  $effect(() => {
    const area = grab;
    if (!area) return;
    let from: number | undefined;
    const start = (event: TouchEvent) => (from = event.touches[0]?.clientY);
    const move = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (from !== undefined && y !== undefined) drag = Math.max(0, y - from);
    };
    const end = () => {
      if (drag > DRAG_CLOSE) closeSheet();
      from = undefined;
      drag = 0;
    };
    area.addEventListener('touchstart', start, { passive: true });
    area.addEventListener('touchmove', move, { passive: true });
    area.addEventListener('touchend', end);
    area.addEventListener('touchcancel', end);
    return () => {
      area.removeEventListener('touchstart', start);
      area.removeEventListener('touchmove', move);
      area.removeEventListener('touchend', end);
      area.removeEventListener('touchcancel', end);
    };
  });
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
    <button type="button" class="chip more" aria-haspopup="dialog" onclick={openSheet}>More…</button
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

<!-- The sheet: every section, each one sideways row that "All ›" opens into a grid in place, under a pinned header. -->
<dialog
  class="sheet"
  bind:this={sheet}
  aria-label="All categories"
  tabindex="-1"
  onclose={closed}
  style:translate={drag ? `0 ${drag}px` : undefined}
>
  <div class="grab" bind:this={grab}>
    <span class="handle" aria-hidden="true"></span>
    <header>
      <h2 class="title">Browse</h2>
      <button type="button" class="close" aria-label="Close" onclick={() => closeSheet()}>✕</button>
    </header>
  </div>
  <div class="sheet-body">
    {#each sheetSections as section (section.group)}
      <div class="sheet-section" role="group" aria-label={section.heading}>
        <h3 class="heading">{section.heading}</h3>
        <div class="row" class:spread={spread[section.group]}>
          {#each section.chips as item (item.id)}{@render chip(item)}{/each}
          {#if section.chips.length > STRIP_FIRST && !spread[section.group]}
            <button
              type="button"
              class="chip all"
              aria-label="All {section.heading}"
              onclick={() => (spread[section.group] = true)}>All ›</button
            >
          {/if}
        </div>
      </div>
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

  /* The sheet: from the bottom on a phone, where the thumb is, to 85% of its height; a panel in the middle from
     760px. The handle and header stay put while the sections scroll under them. */
  .sheet {
    width: 100%;
    max-width: 100%;
    height: 85dvh;
    max-height: 85dvh;
    margin: auto 0 0;
    padding: 0;
    overflow: hidden;
    border: 1px solid var(--line);
    border-bottom: 0;
    border-radius: 20px 20px 0 0;
    background: var(--bg);
    color: var(--fg);
  }

  .sheet[open] {
    display: flex;
    flex-direction: column;
  }

  .sheet::backdrop {
    background: rgb(0 0 0 / 0.6);
  }

  .grab {
    flex-shrink: 0;
    padding: 8px 16px 0;
    touch-action: none;
  }

  .handle {
    display: block;
    width: 36px;
    height: 5px;
    margin: 0 auto 6px;
    border-radius: 3px;
    background: var(--line);
  }

  .sheet header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding-bottom: 6px;
  }

  .title {
    margin: 0;
    font-size: 17px;
  }

  .close {
    display: grid;
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: rgb(255 255 255 / 0.08);
    color: var(--muted);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .close:hover {
    color: var(--fg);
  }

  .sheet-body {
    flex: 1;
    min-height: 0;
    padding: 0 0 calc(16px + env(safe-area-inset-bottom));
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .sheet-section .heading {
    margin: 14px 16px 8px;
  }

  /* One sideways row a section, fading at its right edge to say it goes on; "All ›" lays it out in full. */
  .row {
    display: flex;
    gap: 8px;
    padding: 0 40px 0 16px;
    overflow-x: auto;
    scrollbar-width: none;
    mask-image: linear-gradient(to right, #000 calc(100% - 40px), transparent);
  }

  .row::-webkit-scrollbar {
    display: none;
  }

  .row.spread {
    flex-wrap: wrap;
    padding-right: 16px;
    overflow-x: visible;
    mask-image: none;
  }

  /* The rail's quiet chips: no outline, a faint fill, muted until pointed at. */
  .sheet .chip {
    min-height: 34px;
    padding: 0 12px;
    border: 0;
    background: rgb(255 255 255 / 0.06);
    font-weight: 500;
  }

  .sheet .chip[aria-pressed='true'] {
    background: rgb(255 255 255 / 0.16);
    color: var(--fg);
  }

  .sheet .all {
    background: transparent;
    color: var(--muted);
  }

  @media (width >= 760px) {
    .sheet {
      width: min(640px, 100% - 48px);
      height: auto;
      max-height: 80dvh;
      margin: auto;
      border-bottom: 1px solid var(--line);
      border-radius: 20px;
    }
  }
</style>
