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
    top: calc(100% + 8px);

    /* Hung off its own left edge: this row begins beside the poster, so a panel anchored right would
       open toward the middle of the page instead of under the mark it belongs to. */
    left: 0;
    width: 300px;
    max-width: min(300px, calc(100vw - 2 * var(--gutter)));
    padding: 16px;
    background: #222228;
    border: 1px solid var(--line);
    border-radius: 12px;
    box-shadow: 0 12px 40px #0008;
    font-size: 13px;
  }

  ul {
    margin: 0 0 12px;
    padding-left: 20px;
  }

  li + li {
    margin-top: 8px;
  }

  a {
    color: var(--accent);
  }
</style>
