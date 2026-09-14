<!-- Opens every row that opens, in one section or on the whole page, and closes them again: an icon, named for what it
     does next. Absent where nothing opens. -->
<script lang="ts">
  import { rows } from './rows.svelte';

  let { section, label }: { section?: string; label: string } = $props();

  const allOpen = $derived(rows.allOpen(section));
  const action = $derived(allOpen ? 'Collapse all' : 'Expand all');
</script>

{#if rows.any(section)}
  <button
    type="button"
    class="expand-all"
    aria-label="{action} in {label}"
    title={action}
    onclick={() => rows.setAll(!allOpen, section)}
  >
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      {#if allOpen}
        <!-- Chevrons meeting: fold everything away. -->
        <path d="m7 4 5 5 5-5M7 20l5-5 5 5" />
      {:else}
        <!-- Chevrons parting: open everything up. -->
        <path d="m7 9 5-5 5 5M7 15l5 5 5-5" />
      {/if}
    </svg>
  </button>
{/if}

<style>
  .expand-all {
    display: grid;
    flex-shrink: 0;
    place-items: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }

  .expand-all:hover {
    background: rgb(255 255 255 / 0.06);
    color: var(--fg);
  }

  .expand-all:focus-visible {
    outline: 2px solid var(--accent);
  }

  svg {
    fill: none;
    stroke: currentcolor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
