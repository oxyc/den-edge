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
  <h1>Linked to {link.name ?? 'your Apple TV'}</h1>
  {#if link.linkedAt}
    <p class="sub">Since {new Date(link.linkedAt).toLocaleDateString()}.</p>
  {/if}
  <!-- The companion page's tools (send to TV, plugins, keys) until they move here. It shares this link. -->
  <a class="tools glass" href="/app/">Companion tools</a>
  <button class="quiet" onclick={unlink}>{confirming ? 'Press again to unlink' : 'Unlink'}</button>
</section>

<style>
  section {
    display: grid;
    justify-items: center;
    gap: 16px;
    max-width: 420px;
    margin: 8vh auto 0;
    text-align: center;
  }

  h1 {
    margin: 0;
    font-size: 28px;
  }

  .sub {
    margin: 0;
    color: var(--muted);
  }

  .tools {
    padding: 12px 22px;
    border-radius: 999px;
    color: var(--fg);
    font-weight: 600;
    text-decoration: none;
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
