<script lang="ts">
  import { i18n } from '../lib/i18n.svelte';
  import Confirm from '../settings/Confirm.svelte';

  let { message, ondiscard }: { message: string; ondiscard: () => void } = $props();
</script>

<div class="library-status" role="alert">
  <p>{i18n.phrase(message)}</p>
  <Confirm
    label="Start with an empty library…"
    question="Discard this old backup?"
    detail="This removes the old library kept only in this browser. Use it only when there is no watchlist, watched history, progress, or settings you want to keep."
    confirmLabel="Start empty"
    onconfirm={ondiscard}
  />
</div>

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

  p {
    margin: 0 0 12px;
  }
</style>
