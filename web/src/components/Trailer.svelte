<!-- A title's trailer, in YouTube's embed (youtube-nocookie.com): the web's trailers, from the YouTube id TMDB lists —
     the one the TV falls back to when it can't reach den-reel. -->
<script lang="ts">
  let { key, title, onclose }: { key: string; title: string; onclose: () => void } = $props();

  // The page behind stays put: it would otherwise scroll under the overlay.
  $effect(() => {
    const scrolls = [document.documentElement, document.body].map((el) => [el, el.style.overflow] as const);
    for (const [el] of scrolls) el.style.overflow = 'hidden';
    return () => {
      for (const [el, overflow] of scrolls) el.style.overflow = overflow;
    };
  });
</script>

<svelte:window onkeydown={(event) => event.key === 'Escape' && !document.fullscreenElement && onclose()} />

<div class="trailer" role="dialog" aria-modal="true" aria-label={`${title}: trailer`}>
  <header>
    <b>{title}</b>
    <button onclick={onclose}>Close</button>
  </header>
  <!-- The page sends no referrer, and YouTube's embed refuses to play without one: this frame sends its origin. -->
  <iframe
    src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(key)}?autoplay=1&rel=0&playsinline=1`}
    title={`${title}: trailer`}
    allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
    allowfullscreen
    referrerpolicy="strict-origin-when-cross-origin"
  ></iframe>
</div>

<style>
  .trailer {
    position: fixed;
    inset: 0 0 auto;
    z-index: 50;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    height: 100vh;
    height: 100dvh;
    /* Clear of a phone's camera cutout on every side, as the player is. */
    padding: max(12px, env(safe-area-inset-top)) max(var(--gutter), env(safe-area-inset-right))
      max(12px, env(safe-area-inset-bottom)) max(var(--gutter), env(safe-area-inset-left));
    background: #000;
    color: #fff;
  }

  header {
    display: flex;
    gap: 16px;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 12px;
  }

  header b {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  button {
    flex: 0 0 auto;
    padding: 8px 16px;
    border: 1px solid rgb(255 255 255 / 0.4);
    border-radius: 999px;
    background: none;
    color: #fff;
    font: inherit;
    cursor: pointer;
  }

  iframe {
    width: 100%;
    height: 100%;
    border: 0;
  }
</style>
