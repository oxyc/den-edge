<script lang="ts">
  import { i18n } from '../lib/i18n.svelte';
  let {
    label = 'Loading',
    page = false,
    inline = false,
  }: {
    label?: string;
    page?: boolean;
    /** Beside the label, which is then shown: a step in a form ("Working…"), not a whole area loading. */
    inline?: boolean;
  } = $props();
</script>

<div
  class="loading"
  class:page
  class:inline
  role="status"
  data-route-loading={page ? '' : undefined}
>
  <span class="spinner" aria-hidden="true"></span>
  <span class="label">{i18n.phrase(label)}</span>
</div>

<style>
  .loading {
    display: grid;
    place-items: center;
    min-height: 80px;
  }

  .page {
    position: fixed;
    inset: 0;
    z-index: 8;
    display: flex;
    flex-direction: column;
    gap: 14px;
    align-items: center;
    justify-content: center;
    pointer-events: none;

    /* Shown only for a wait long enough to notice: a page that loads at once must not flash one. */
    opacity: 0;
    animation: appear 0.2s ease-out 0.4s forwards;
  }

  @keyframes appear {
    to {
      opacity: 1;
    }
  }

  .spinner {
    width: 28px;
    height: 28px;
    border: 3px solid rgb(255 255 255 / 0.18);
    border-top-color: var(--fg, #fff);
    border-radius: 50%;
    animation: turn 0.75s linear infinite;
  }

  .inline {
    display: flex;
    gap: 10px;
    align-items: center;
    min-height: 0;
    margin-top: 12px;
    color: var(--muted);
    font-size: 14px;
  }

  .inline .spinner {
    width: 18px;
    height: 18px;
    border-width: 2px;
  }

  .loading:not(.inline) .label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* Full-page waits can otherwise look like a frozen app, especially on the first device opening a linked
     library. Unlike an incidental in-card spinner, this state owns the screen and should say what is happening. */
  .loading.page .label {
    position: static;
    width: auto;
    height: auto;
    overflow: visible;
    clip-path: none;
    white-space: normal;
  }

  @keyframes turn {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
