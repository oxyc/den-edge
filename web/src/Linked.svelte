<script lang="ts">
  import { links, type Link } from './lib/links.svelte';

  let { link }: { link: Link } = $props();
  // Unlinking asks twice: a second press within a few seconds confirms, so a stray tap does nothing.
  let confirming = $state(false);

  function unlink() {
    if (!confirming) {
      confirming = true;
      setTimeout(() => (confirming = false), 4000);
      return;
    }
    links.remove(link.inboxKey);
  }
</script>

<section>
  <h1>Linked to your Apple TV</h1>
  <p class="sub">Since {new Date(link.linkedAt).toLocaleDateString()}.</p>
  <button class="quiet" onclick={unlink}>{confirming ? 'Press again to unlink' : 'Unlink'}</button>
</section>

<style>
  section {
    max-width: 420px;
    margin: 8vh auto 0;
    text-align: center;
  }

  h1 {
    margin: 0 0 8px;
    font-size: 28px;
  }

  .sub {
    margin: 0 0 24px;
    color: var(--muted);
  }

  .quiet {
    padding: 12px 20px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: none;
    color: var(--danger);
    cursor: pointer;
  }
</style>
