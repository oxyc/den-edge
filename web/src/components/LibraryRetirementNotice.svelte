<script lang="ts">
  import Button from './Button.svelte';
  import { i18n } from '../lib/i18n.svelte';
  import { libraryRetirements } from '../lib/libraryRetirement.svelte';

  const failed = $derived(libraryRetirements.pending.filter((receipt) => receipt.failure));
</script>

{#if failed.length}
  <aside class="retirement" role="alert" aria-labelledby="library-retirement-title">
    <div>
      <strong id="library-retirement-title">{i18n.text('retirement.title')}</strong>
      <p>{i18n.text('retirement.detail')}</p>
      {#if failed.some((receipt) => receipt.failure === 'wait')}
        <p>{i18n.text('retirement.waiting')}</p>
      {/if}
    </div>
    {#if failed.some((receipt) => receipt.failure === 'storage')}
      <Button
        variant="primary"
        label={i18n.text('retirement.retry')}
        onclick={() => libraryRetirements.retry()}
      />
    {/if}
  </aside>
{/if}

<style>
  .retirement {
    position: fixed;
    z-index: 100;
    right: max(16px, env(safe-area-inset-right));
    bottom: max(16px, env(safe-area-inset-bottom));
    left: max(16px, env(safe-area-inset-left));
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    max-width: 760px;
    margin: 0 auto;
    padding: 16px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--surface, #171717);
    box-shadow: 0 12px 36px rgb(0 0 0 / 0.45);
  }

  strong,
  p {
    margin: 0;
  }

  p {
    margin-top: 4px;
    color: var(--muted);
    font-size: 14px;
  }

  @media (width <= 520px) {
    .retirement {
      align-items: stretch;
      flex-direction: column;
    }
  }
</style>
