<script lang="ts">
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
  <span class="label">{label}</span>
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
    pointer-events: none;
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
