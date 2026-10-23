<script lang="ts">
  import LibraryStatus from '../src/components/LibraryStatus.svelte';

  let discarded = $state(false);
</script>

<LibraryStatus
  toast={null}
  alert="This backup predates Library v4. Restore it with a build that can convert Library v3 first."
  recovery={{
    label: 'Start with an empty library…',
    question: 'Discard this old backup?',
    detail: 'This removes the old library kept only in this browser.',
    confirmLabel: 'Start empty',
    run: () => (discarded = true),
  }}
/>

{#if discarded}<p role="status">Empty library started</p>{/if}
