<!-- One recovery ceremony belongs to exactly one library authority. Settings keys this adapter by model identity, so
     replacement destroys the old presentation while every late operation and its cleanup stays on the captured
     authority that began it. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { Immutable, LibraryModel } from '../lib/libraryModel.svelte';
  import type { RecoveryView } from '../lib/libraryServiceProtocol';
  import RecoveryCode from './RecoveryCode.svelte';
  import type { RecoveryAbandonOutcome, RecoveryConfirmationOutcome } from './recoveryConfirmation';

  let {
    authority,
    view,
    ready,
    run,
  }: {
    authority: LibraryModel;
    view?: Immutable<RecoveryView>;
    ready: boolean;
    run: (action: () => Promise<unknown>) => Promise<boolean>;
  } = $props();

  // This adapter is keyed by the parent's authority identity. Do not let reactive prop replacement retarget an old
  // ceremony or the teardown cleanup that may follow its late reply.
  const owned = untrack(() => authority);

  async function seal(locator: string, wrapKey: string, createdAt: number): Promise<string> {
    const { result } = await owned.sealRecovery(locator, wrapKey, createdAt);
    if (result.kind !== 'recovery.seal') throw new Error('wrong recovery response');
    return result.sealed;
  }

  async function begin(locator: string, sealed: string, createdAt: number): Promise<string> {
    const { result } = await owned.beginRecovery(locator, sealed, createdAt);
    return 'outcome' in result ? result.outcome : 'failed';
  }

  async function confirm(
    locator: string,
    operationId: string,
  ): Promise<RecoveryConfirmationOutcome> {
    try {
      const { result } = await owned.confirmRecovery(locator, operationId);
      if (result.kind !== 'recovery.confirm') return { state: 'pending' };
      return result.outcome === 'confirmed'
        ? { state: 'committed' }
        : result.outcome === 'lost'
          ? { state: 'lost' }
          : { state: 'pending' };
    } catch {
      return { state: 'pending' };
    }
  }

  async function abandon(locator: string, operationId: string): Promise<RecoveryAbandonOutcome> {
    try {
      const { result } = await owned.abandonRecovery(locator, operationId);
      if (result.kind !== 'recovery.abandon') return { state: 'pending' };
      return result.outcome === 'confirmed'
        ? { state: 'committed' }
        : result.outcome === 'failed'
          ? { state: 'pending' }
          : { state: result.outcome };
    } catch {
      return { state: 'pending' };
    }
  }
</script>

<RecoveryCode
  {view}
  {ready}
  {seal}
  {begin}
  {confirm}
  {abandon}
  disable={() => run(() => owned.disableRecovery())}
/>
