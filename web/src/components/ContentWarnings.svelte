<script lang="ts">
  import DetailIcon from './DetailIcon.svelte';
  import { fetchWarnings, type Warning } from '../lib/contentWarnings';
  import type { TitleDetail } from '../lib/detail';
  let {
    detail,
    apiKey,
    categories,
  }: { detail: TitleDetail; apiKey: string; categories: string[] } = $props();
  let content = $state<{ id: number; warnings: Warning[] } | null>(null);
  $effect(() => {
    const controller = new AbortController();
    content = null;
    void fetchWarnings(detail, apiKey, categories, controller.signal).then((loaded) => {
      if (!controller.signal.aborted) content = loaded;
    });
    return () => controller.abort();
  });
</script>

{#if content?.warnings.length}
  <details>
    <!-- Beside the age certificate, carrying the same border and size: what a title contains belongs in
         the row where what it is rated is already read. This one answers to hover and focus, which the
         certificate never does, and the label carries the count for anyone who cannot see the mark. -->
    <summary class="chip" aria-label="Content warnings: {content.warnings.length}"
      ><DetailIcon name="warning" />{content.warnings.length}</summary
    >
    <div class="warnings">
      <p class="heading">Content warnings</p>
      <ul>
        {#each content.warnings as warning (warning.id)}<li>{warning.label}</li>{/each}
      </ul>
      <!-- The wording doesthedogdie's API terms require wherever their data shows (§6), word for word. -->
      <a href="https://www.doesthedogdie.com" target="_blank" rel="noopener noreferrer"
        >Powered by DoesTheDogDie.com</a
      >
    </div>
  </details>
{/if}

<style>
  details {
    position: relative;
    display: inline-block;
  }

  summary {
    position: relative;
    display: inline-flex;
    gap: 4px;
    align-items: center;
    color: var(--muted);
    cursor: pointer;
    list-style: none;
  }

  /* The mark is the same size as the certificate beside it, so the press area grows outwards rather than
     making the box taller: an invisible reach past the border, which is room for a finger without a chip
     that stands out from the row it sits in. */
  summary::before {
    content: '';
    position: absolute;
    inset: -6px;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* The border is `currentcolor`, so brightening the text brightens the border with it. */
  summary:hover,
  details[open] summary {
    color: var(--fg);
  }

  /* Sized to the 12px text it stands beside, so neither one sets the chip's height. */
  summary :global(svg) {
    width: 12px;
    height: 12px;
  }

  .warnings {
    position: absolute;
    z-index: 5;
    top: calc(100% + 10px);

    /* Hung off its own left edge: this row begins beside the poster, so a panel anchored right would
       open toward the middle of the page instead of under the mark it belongs to. */
    left: 0;
    width: 320px;
    max-width: min(320px, calc(100vw - 2 * var(--gutter)));
    padding: 14px 16px 12px;
    background: #1c1c22;
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: 0 18px 50px rgb(0 0 0 / 0.55);
    color: var(--fg);
    font-size: 13px;
    line-height: 1.4;
  }

  /* What the list is. The mark that opens it is a triangle and a number, which says there is something
     to read but not what — and the panel opens over a page of other text, so it needs its own name. */
  .heading {
    margin: 0 0 8px;
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  /* No bullets: these are short phrases rather than prose, and a hairline between them separates them
     more quietly than a column of dots, which at this width read as clutter down the left edge. */
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    padding: 6px 0;
  }

  li + li {
    border-top: 1px solid var(--line);
  }

  /* The credit the terms require, kept as a footer: present and legible, but not competing with the
     warnings for attention, and set off by the same hairline that divides them. */
  a {
    display: block;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--line);
    color: var(--muted);
    font-size: 11px;
    text-decoration: none;
  }

  a:hover,
  a:focus-visible {
    color: var(--accent);
    text-decoration: underline;
  }

  /* A phone has no room to hang a panel off this chip. The row begins beside the poster, so a panel
     anchored to the mark's own left edge started well into the width and ran past the right one — and the
     page clips horizontally rather than scrolling, so the warnings and the credit under them were cut off
     and unreachable. Here it is a sheet across the page instead, which is also how this phone opens the
     player's own menus. */
  @media (width <= 759px) {
    .warnings {
      position: fixed;
      z-index: 40;
      inset: auto var(--gutter) max(12px, env(safe-area-inset-bottom));
      width: auto;
      max-width: none;
      max-height: 60vh;
      overflow-y: auto;
    }
  }
</style>
