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
    <!-- A mark and a number, not a labelled button. This sits over a title's artwork, where a pill with
         a border reads as a control somebody is meant to press — and it is only a note about what the
         film contains. The words stay for anyone who cannot see the mark. -->
    <summary aria-label="Content warnings: {content.warnings.length}"
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
    position: absolute;
    z-index: 3;
    top: calc(var(--bar-space) + 12px);

    /* Clear of the hero's expand control, which holds this corner at 44px wide and sits beneath this at
       z-index 1 — so the pill that used to be here covered it outright. Level with it rather than four
       pixels above, since they now read as two marks in a row. */
    right: calc(var(--gutter) + 56px);
    max-width: calc(100% - 32px);
    color: var(--fg);
    font-size: 13px;
  }

  summary {
    display: flex;
    gap: 4px;
    align-items: center;
    width: max-content;
    cursor: pointer;

    /* No plate behind it, so the shadow is what keeps it legible over a bright frame — the same trick
       the billboard's text uses. */
    color: rgb(255 255 255 / 0.85);
    filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.85));
    list-style: none;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary :global(svg) {
    width: 17px;
    height: 17px;
  }

  .warnings {
    position: absolute;
    top: 44px;
    right: 0;
    width: 300px;
    max-width: calc(100vw - 32px);
    background: #1b1b21;
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 16px;
    box-shadow: 0 8px 30px #0008;
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

  @media (width <= 759px) {
    details {
      top: 12px;

      /* The corner is free here: a phone reaches full screen through the video's own controls, so there
         is no expand control to stand clear of. */
      right: var(--gutter);
    }
  }
</style>
