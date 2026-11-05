<script lang="ts">
  import { onDestroy } from 'svelte';
  import LegacyBackupRecovery from '../src/components/LegacyBackupRecovery.svelte';
  import LibraryStatus from '../src/components/LibraryStatus.svelte';
  import type { ContentServiceClientPort } from '../src/lib/contentServiceClient';
  import { legacyProfileSession } from '../src/lib/profileSession.svelte';

  let discarded = $state(false);
  let undoResult = $state('');
  const content = {
    query: async () => {
      throw new Error('not used by the notice fixture');
    },
    onStatus: () => () => {},
  } as unknown as ContentServiceClientPort;
  const session = legacyProfileSession(null, false, null, content);

  onDestroy(() => session.close());

  function notify(holdMs = 6_000) {
    session.notify('Library is ready', { holdMs });
  }

  function notifyUndo(owner: string, holdMs = 6_000) {
    session.notify('Removed from watchlist', {
      holdMs,
      undo: { label: 'Undo', run: () => (undoResult = owner) },
    });
  }
</script>

<LegacyBackupRecovery
  message="This backup predates Library v4. Restore it with a build that can convert Library v3 first."
  ondiscard={() => (discarded = true)}
/>

{#if discarded}<p role="status">Empty library started</p>{/if}

<section aria-label="Notice fixture">
  <button type="button" onclick={() => notify(1_000)}>Notify briefly</button>
  <button type="button" onclick={() => notifyUndo('first', 1_000)}>First Undo notice</button>
  <button type="button" onclick={() => notifyUndo('replacement', 1_000)}
    >Replacement Undo notice</button
  >
  <LibraryStatus
    toast={session.toast}
    presentation={session.toastPresentation}
    alert={session.alert}
    undo={session.undo}
  />
  {#if undoResult}<output aria-label="Undo owner">{undoResult}</output>{/if}
</section>
