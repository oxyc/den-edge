<script lang="ts">
  import LegacyBackupRecovery from '../src/components/LegacyBackupRecovery.svelte';

  let discarded = $state(false);
</script>

<LegacyBackupRecovery
  message="This backup predates Library v4. Restore it with a build that can convert Library v3 first."
  ondiscard={() => (discarded = true)}
/>

{#if discarded}<p role="status">Empty library started</p>{/if}
