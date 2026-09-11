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
    <!-- The way out of an embed that won't play: a trailer whose owner disabled embedding shows only "Watch on
         YouTube" here, and nothing in the page can be told that happened. On a phone the link opens the app. -->
    <a
      class="out"
      href={`https://www.youtube.com/watch?v=${encodeURIComponent(key)}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      {@render out()}<span class="label">YouTube, in a new tab</span>
    </a>
    <button class="close" onclick={onclose}>
      {@render cross()}<span class="label">Close</span>
    </button>
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

{#snippet out()}
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M14 4.5h5.5V10" />
    <path d="M19.5 4.5 12 12" />
    <path d="M18 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4.5" />
  </svg>
{/snippet}

{#snippet cross()}
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18" /></svg>
{/snippet}

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
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .out,
  .close {
    display: flex;
    flex: 0 0 auto;
    gap: 8px;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 0 14px;
    border: 1px solid rgb(255 255 255 / 0.4);
    border-radius: 999px;
    background: none;
    color: #fff;
    font: inherit;
    text-decoration: none;
    cursor: pointer;
  }

  /* Closing is one glyph, as it is in the player, and it stands beside the title rather than among controls. */
  .close {
    width: 44px;
    padding: 0;
    border-color: transparent;
  }

  /* Read out at every width, drawn only where the title can spare it. */
  .label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @media (min-width: 560px) {
    .out .label {
      position: static;
      width: auto;
      height: auto;
      clip-path: none;
    }
  }

  .icon {
    flex: 0 0 auto;
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentcolor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .out:focus-visible,
  .close:focus-visible {
    border-color: var(--accent);
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  iframe {
    width: 100%;
    height: 100%;
    border: 0;
  }
</style>
