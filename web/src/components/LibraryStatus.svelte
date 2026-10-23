<!-- What the library itself says, above every page: a passing note ("Library updated to v4" on the browser that made
     the switch), and what keeps it from being written while that lasts ("Library update required"). -->
<script lang="ts">
  import Confirm from '../settings/Confirm.svelte';

  let {
    toast,
    alert,
    undo = null,
    recovery = null,
  }: {
    toast: string | null;
    alert: string | null;
    /** Offered on the toast itself — "Removed from watchlist · Undo" — for the two actions that take something away. */
    undo?: { label: string; run: () => void } | null;
    /** An explicit way out of a read-only library that cannot be upgraded by this build. */
    recovery?: {
      label: string;
      question: string;
      detail: string;
      confirmLabel: string;
      run: () => void;
    } | null;
  } = $props();
</script>

{#if alert}<div class="library-status" role="alert">
    <p>{alert}</p>
    {#if recovery}
      <Confirm
        label={recovery.label}
        question={recovery.question}
        detail={recovery.detail}
        confirmLabel={recovery.confirmLabel}
        onconfirm={recovery.run}
      />
    {/if}
  </div>{/if}
{#if toast}<p class="library-status toast" role="status">
    <span>{toast}</span>{#if undo}<button type="button" class="undo" onclick={undo.run}
        >{undo.label}</button
      >{/if}
  </p>{/if}

<style>
  .library-status {
    position: relative;
    z-index: 4;
    margin: 0 0 18px;
    padding: 12px 16px;
    border: 1px solid var(--accent-outline-45);
    border-radius: 12px;
    background: var(--accent-surface);
    color: var(--fg);
  }

  .library-status > p {
    margin: 0;
  }

  .library-status > p + :global(*) {
    margin-top: 12px;
  }

  .toast {
    position: fixed;
    inset: auto var(--gutter) calc(24px + env(safe-area-inset-bottom));
    z-index: 30;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    max-width: 420px;
    margin: 0 auto;
    box-shadow: 0 8px 28px rgb(0 0 0 / 0.4);
    text-align: center;
  }

  .undo {
    flex: 0 0 auto;
    border: 0;
    padding: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .undo:focus-visible {
    outline: var(--ring-width) solid var(--focus-ring);
    outline-offset: 2px;
  }
</style>
