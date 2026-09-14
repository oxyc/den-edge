<!-- Opens every row that opens, in one section or on the whole page, and closes them again: a quiet word beside the
     heading, named for what it does next. Absent where nothing opens. -->
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
    onclick={() => rows.setAll(!allOpen, section)}>{action}</button
  >
{/if}

<style>
  .expand-all {
    flex-shrink: 0;
    padding: 4px 6px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
  }

  .expand-all:hover {
    color: var(--fg);
  }

  .expand-all:focus-visible {
    outline: 2px solid var(--accent);
  }
</style>
