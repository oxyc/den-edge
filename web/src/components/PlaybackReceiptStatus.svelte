<script lang="ts">
  import { i18n } from '../lib/i18n.svelte';

  const message = {
    pending: 'Checking saved playback progress…',
    failed: 'Saved playback progress couldn’t be updated. Try again.',
    recovered: 'Saved playback progress is up to date.',
  } as const;
  const layout = 'display:flex;align-items:center;justify-content:center;gap:16px';
  const failedLayout = `${layout};border-color:var(--danger-outline, var(--accent-outline-45))`;
  let { state, retry }: { state: keyof typeof message; retry: () => void } = $props();
</script>

<p
  class="library-status receipt"
  role={state === 'failed' ? 'alert' : 'status'}
  aria-busy={state === 'pending'}
  style={state === 'failed' ? failedLayout : layout}
>
  <span>{i18n.phrase(message[state])}</span>
  {#if state === 'failed'}<button type="button" class="undo" onclick={retry}
      >{i18n.phrase('Try again')}</button
    >{/if}
</p>
