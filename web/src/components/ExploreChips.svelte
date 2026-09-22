<!-- Search's Explore categories (the TV's Explore rail): For You, the genres, the recipes and atlas's moods, one open
     at a time. One control laid out three ways: a strip that scrolls sideways on a phone, where a thumb reaches
     it; wrapped lines on a tablet; and a rail down the side on a wide screen, grouped as the TV's rail is. -->
<script lang="ts">
  import type { Chip, ChipGroup } from '../lib/explore';

  let {
    chips,
    value,
    onchange,
  }: {
    chips: Chip[];
    /** The open chip's id. */
    value: string;
    onchange: (id: string) => void;
  } = $props();

  const HEADINGS: Record<ChipGroup, string> = {
    'for-you': '',
    genre: 'Genres',
    recipe: 'Recipes',
    mood: 'Moods',
  };
  const groups = $derived(
    (['for-you', 'genre', 'recipe', 'mood'] as const).flatMap((group) => {
      const inGroup = chips.filter((chip) => chip.group === group);
      return inGroup.length ? [{ group, chips: inGroup }] : [];
    }),
  );
  let strip = $state<HTMLElement>();

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

<nav class="chips" aria-label="Browse by category" bind:this={strip}>
  {#each groups as { group, chips: inGroup } (group)}
    <div class="group" role="group" aria-label={HEADINGS[group] || 'For You'}>
      {#if HEADINGS[group]}<span class="heading">{HEADINGS[group]}</span>{/if}
      {#each inGroup as chip (chip.id)}
        <button
          type="button"
          aria-pressed={chip.id === value}
          data-chip={chip.id}
          onclick={() => onchange(chip.id)}>{chip.label}</button
        >
      {/each}
    </div>
  {/each}
</nav>

<style>
  /* A phone: one line, sideways. The groups flow on as one strip, their headings left out. */
  .chips {
    display: flex;

    /* As wide as the column it sits in, not as its chips: only then does the strip scroll. */
    align-self: stretch;
    min-width: 0;
    gap: 8px;
    margin-inline: calc(-1 * var(--gutter));
    padding: 4px var(--gutter) 8px;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .chips::-webkit-scrollbar {
    display: none;
  }

  .group {
    display: contents;
  }

  .heading {
    display: none;
  }

  button {
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

  button:hover {
    color: var(--fg);
  }

  button[aria-pressed='true'] {
    border-color: transparent;
    background: var(--fg);
    color: var(--bg);
  }

  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* A tablet: every chip in view, wrapped. */
  @media (width >= 760px) {
    .chips {
      flex-wrap: wrap;
      margin-inline: 0;
      padding-inline: 0;
      overflow: visible;
    }
  }

  /* A wide screen: a rail, grouped under headings, as the TV's is. */
  @media (width >= 1100px) {
    .chips {
      flex-flow: column nowrap;
      gap: 18px;
      padding: 0;
    }

    .group {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 2px;
    }

    .heading {
      display: block;
      margin: 0 0 4px 12px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    button {
      min-height: 32px;
      padding: 0 12px;
      border: 0;
      border-radius: 8px;
      background: transparent;
      text-align: left;
    }

    button:hover {
      background: rgb(255 255 255 / 0.06);
    }

    button[aria-pressed='true'] {
      background: rgb(255 255 255 / 0.14);
      color: var(--fg);
    }
  }
</style>
