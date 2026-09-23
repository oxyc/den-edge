<!-- The picks over a browsed grid — Explore's and People's: each a quiet pill that takes it out, then "Clear all". A
     paused pick (Explore's, while a query is typed) is drawn dashed and said so. A pick that joins the one before it
     as either-or (`or`, one kind's values: "Swedish or Danish") has an "or" between them. -->
<script lang="ts">
  import type { Chip } from '../lib/explore';

  let {
    picks,
    onremove,
    onclear,
  }: {
    picks: { chip: Chip; paused?: boolean; or?: boolean }[];
    onremove: (id: string) => void;
    onclear: () => void;
  } = $props();
</script>

{#if picks.length}
  <div class="picks" role="group" aria-label="Selected">
    {#each picks as { chip, paused, or } (chip.id)}
      {#if or}<span class="or">or</span>{/if}
      <button
        type="button"
        class="pick"
        class:paused
        aria-label="Remove {chip.label}"
        data-chip={chip.id}
        onclick={() => onremove(chip.id)}
        >{chip.label}<span class="x" aria-hidden="true">✕</span></button
      >
    {/each}
    <button type="button" class="clear" onclick={onclear}>Clear all</button>
    {#if picks.some((p) => p.paused)}
      <span class="paused-note">Paused while searching — clear search to apply</span>
    {/if}
  </div>
{/if}

<style>
  /* The picks: small, outlined, muted — a note of what is applied, not chips competing with the rail's. */
  .picks {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin: 0 0 14px;
  }

  .pick {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    min-height: 28px;
    padding: 0 8px 0 10px;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 13px;
    white-space: nowrap;
    text-overflow: ellipsis;
    cursor: pointer;
  }

  .pick:hover {
    border-color: var(--muted);
    color: var(--fg);
  }

  .x {
    font-size: 10px;
  }

  .or {
    color: var(--muted);
    font-size: 12px;
  }

  .clear {
    min-height: 28px;
    margin-left: 6px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 13px;
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
  }

  .clear:hover {
    color: var(--fg);
  }

  .pick:focus-visible,
  .clear:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .pick.paused {
    border-style: dashed;
    opacity: 0.55;
  }

  .paused-note {
    color: var(--muted);
    font-size: 12px;
  }
</style>
