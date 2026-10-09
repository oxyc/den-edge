<!-- A title's trailer, in YouTube's embed (youtube-nocookie.com): the web's trailers, from the YouTube id TMDB lists —
     the one the TV falls back to when it can't reach den-reel. -->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Button from './Button.svelte';
  import ButtonIcon from './ButtonIcon.svelte';

  let { key, title, onclose }: { key: string; title: string; onclose: () => void } = $props();

  let out = $state<HTMLAnchorElement>();
  let close = $state<HTMLButtonElement>();
  /** Whatever had focus when this opened — the Trailer button, almost always — so it gets focus back on close,
      whatever closes it: the Close button, Escape, or the page unmounting this some other way. */
  let opener: HTMLElement | null = null;

  onMount(() => {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close?.focus();
  });
  onDestroy(() => opener?.focus());

  /** Tab stays inside the dialog's two controls, rather than walking off into the page behind the overlay. */
  function trapTab(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    if (event.shiftKey ? document.activeElement === out : document.activeElement === close) {
      event.preventDefault();
      (event.shiftKey ? close : out)?.focus();
    }
  }

  // The page behind stays put: it would otherwise scroll under the overlay.
  $effect(() => {
    const scrolls = [document.documentElement, document.body].map(
      (el) => [el, el.style.overflow] as const,
    );
    for (const [el] of scrolls) el.style.overflow = 'hidden';
    return () => {
      for (const [el, overflow] of scrolls) el.style.overflow = overflow;
    };
  });
</script>

<svelte:window
  onkeydown={(event) => event.key === 'Escape' && !document.fullscreenElement && onclose()}
/>

<div
  class="trailer"
  role="dialog"
  aria-modal="true"
  aria-label={`${title}: trailer`}
  tabindex="-1"
  onkeydown={trapTab}
>
  <header>
    <b>{title}</b>
    <!-- The way out of an embed that won't play: a trailer whose owner disabled embedding shows only "Watch on
         YouTube" here, and nothing in the page can be told that happened. On a phone the link opens the app. -->
    <a
      bind:this={out}
      class="den-button den-button-player den-button-regular out"
      href={`https://www.youtube.com/watch?v=${encodeURIComponent(key)}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Open trailer on YouTube in a new tab"
    >
      <ButtonIcon name="external" /><span class="den-button-label out-label">YouTube</span>
    </a>
    <Button
      bind:element={close}
      variant="player"
      size="icon"
      class="close"
      icon="close"
      ariaLabel="Close trailer"
      onclick={onclose}
    />
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
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .out {
    flex: 0 0 auto;
  }

  /* Closing is one glyph, as it is in the player, and it stands beside the title rather than among controls. */
  :global(.den-button.close) {
    --button-bg: transparent;
    --button-border: transparent;

    box-shadow: none;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }

  /* Read out at every width, drawn only where the title can spare it. */
  .out-label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @media (width >= 560px) {
    .out-label {
      position: static;
      width: auto;
      height: auto;
      clip-path: none;
    }
  }

  iframe {
    width: 100%;
    height: 100%;
    border: 0;
  }
</style>
