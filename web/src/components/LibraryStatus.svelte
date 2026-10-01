<!-- What the library itself says, above every page: a passing note ("Library updated to v4" on the browser that made
     the switch), and what keeps it from being written while that lasts ("Library update required"). -->
<script lang="ts">
  let { toast, alert }: { toast: string | null; alert: string | null } = $props();
</script>

{#if alert}<p class="library-status" role="alert">{alert}</p>{/if}
{#if toast}<p class="library-status toast" role="status">{toast}</p>{/if}

<style>
  .library-status {
    position: relative;
    z-index: 4;
    margin: 0 0 18px;
    padding: 12px 16px;
    border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
    border-radius: 12px;
    background: color-mix(in srgb, var(--card) 92%, var(--accent));
    color: var(--fg);
  }

  .toast {
    position: fixed;
    inset: auto var(--gutter) calc(24px + env(safe-area-inset-bottom));
    z-index: 30;
    max-width: 420px;
    margin: 0 auto;
    box-shadow: 0 8px 28px rgb(0 0 0 / 0.4);
    text-align: center;
  }
</style>
