<!-- What a screen built on atlas says while Den's server can't be reached and this browser has no saved address for
     atlas: an answer, not a load that never ends. It also clears by itself once den-edge answers again
     (`SessionServices.retry`). -->
<script lang="ts">
  import { i18n } from '../lib/i18n.svelte';
  import Button from './Button.svelte';

  let {
    onretry,
    message = 'Den’s server can’t be reached right now.',
  }: { onretry: () => void; message?: string } = $props();
</script>

<div class="unreachable" role="alert">
  <p class="note">{i18n.phrase(message)}</p>
  <Button variant="secondary" label="Try again" onclick={onretry} />
</div>

<style>
  .unreachable {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px 16px;
  }

  .note {
    margin: 0;
    color: var(--muted);
  }
</style>
