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
  <span class="who">Linked to {link.name ?? 'your Apple TV'}</span>
  <!-- The companion page's tools (send to TV, plugins, keys) until they move here. It shares this link. -->
  <a class="tools glass" href="/app/">Companion tools</a>
  <button class="quiet" onclick={unlink}>{confirming ? 'Press again to unlink' : 'Unlink'}</button>
</section>

<style>
  section {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-top: 40px;
    padding-top: 20px;
    border-top: 1px solid var(--line);
  }

  .who {
    margin-right: auto;
    color: var(--muted);
  }

  .tools {
    padding: 10px 18px;
    border-radius: 999px;
    color: var(--fg);
    font-weight: 600;
    text-decoration: none;
  }

  .quiet {
    padding: 10px 18px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: none;
    color: var(--danger);
    cursor: pointer;
  }
</style>
