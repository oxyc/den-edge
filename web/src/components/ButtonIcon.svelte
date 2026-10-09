<script lang="ts" module>
  export type ButtonIconName =
    | 'back'
    | 'bookmark'
    | 'cast'
    | 'chevron'
    | 'close'
    | 'download'
    | 'eye'
    | 'external'
    | 'fullscreen'
    | 'heart'
    | 'more'
    | 'mute'
    | 'pause'
    | 'play'
    | 'retry'
    | 'share'
    | 'sources'
    | 'trailer'
    | 'trash'
    | 'thumb-down'
    | 'thumb-up'
    | 'tv'
    | 'volume';
</script>

<script lang="ts">
  let { name, filled = false }: { name: ButtonIconName; filled?: boolean } = $props();
</script>

<svg
  viewBox="0 0 24 24"
  aria-hidden="true"
  focusable="false"
  class:filled
  class:eye={name === 'eye'}
  data-icon={name}
>
  {#if name === 'play'}
    <path d="M8.8 5.6 19 12 8.8 18.4V5.6Z" />
  {:else if name === 'pause'}
    <path d="M8 6v12M16 6v12" />
  {:else if name === 'tv'}
    <rect x="2.8" y="4.5" width="18.4" height="12.5" rx="2.5" />
    <path d="M8.5 20.5h7M10.6 9.4l4.2 2.4-4.2 2.4V9.4Z" />
  {:else if name === 'cast'}
    <path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" />
    <path d="M2 12a9 9 0 0 1 8 8M2 16a5 5 0 0 1 4 4M2 20h.01" />
  {:else if name === 'trailer'}
    <path d="M3.5 9.6h17v8.4a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V9.6Z" />
    <path
      d="m3.7 9.6.6-3.2a1 1 0 0 1 1.2-.8l13.2 2.5a1 1 0 0 1 .8 1.2l-.1.3M8.6 6.4l-.8 3.2M13.2 7.3l-.8 3.2"
    />
  {:else if name === 'bookmark'}
    <path d="M7 4.5h10a1 1 0 0 1 1 1v14l-6-3.7-6 3.7v-14a1 1 0 0 1 1-1Z" />
  {:else if name === 'eye'}
    <path d="M2.5 12S6 6.6 12 6.6 21.5 12 21.5 12 18 17.4 12 17.4 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.9" />
  {:else if name === 'heart'}
    <path
      d="M12 19.6S4.4 15.1 4.4 10a3.9 3.9 0 0 1 7.6-1.4A3.9 3.9 0 0 1 19.6 10c0 5.1-7.6 9.6-7.6 9.6Z"
    />
  {:else if name === 'thumb-up' || name === 'thumb-down'}
    <g transform={name === 'thumb-down' ? 'rotate(180 12 12)' : undefined}>
      <path
        d="M8.6 20.2v-9.8l3.6-6.1a1.3 1.3 0 0 1 2.4.9l-.8 4.3h4.6a2 2 0 0 1 2 2.4l-1.2 6a2 2 0 0 1-2 1.6H8.6Z"
      />
      <path d="M8.6 20.2H5.9a1.4 1.4 0 0 1-1.4-1.4v-7a1.4 1.4 0 0 1 1.4-1.4h2.7" />
    </g>
  {:else if name === 'share'}
    <path
      d="M12 3.6v11.2m-4.1-7.1L12 3.6l4.1 4.1M5.6 12.8v5.6a2 2 0 0 0 2 2h8.8a2 2 0 0 0 2-2v-5.6"
    />
  {:else if name === 'trash'}
    <path d="M5.5 7.5h13M9 7.5V5h6v2.5m2 0-.7 12H7.7L7 7.5m3.2 3v6m3.6-6v6" />
  {:else if name === 'download'}
    <path d="M12 3.5v11m-4-4 4 4 4-4M5 19.5h14" />
  {:else if name === 'external'}
    <path d="M14 4.5h5.5V10M19.5 4.5 12 12" />
    <path d="M18 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4.5" />
  {:else if name === 'sources'}
    <rect x="3" y="4" width="18" height="5" rx="1.5" />
    <rect x="3" y="15" width="18" height="5" rx="1.5" />
    <path d="M7 6.5h.01M7 17.5h.01" />
  {:else if name === 'retry'}
    <path d="M19 8V4m0 0h-4m4 0-3.2 3.2A7 7 0 1 0 18.5 15" />
  {:else if name === 'back'}
    <path d="m14.5 5-7 7 7 7" />
  {:else if name === 'close'}
    <path d="m6 6 12 12M18 6 6 18" />
  {:else if name === 'more'}
    <circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" />
  {:else if name === 'volume'}
    <path d="M4 10v4h4l5 4V6l-5 4H4Zm12-1.5a5 5 0 0 1 0 7" />
  {:else if name === 'mute'}
    <path d="M4 10v4h4l5 4V6l-5 4H4Zm12 0 5 4m0-4-5 4" />
  {:else if name === 'fullscreen'}
    <path d="M9 4H4v5m11-5h5v5M9 20H4v-5m11 5h5v-5" />
  {:else if name === 'chevron'}
    <path d="m6 9.5 6 6 6-6" />
  {/if}
</svg>

<style>
  svg {
    display: block;
    width: var(--button-icon-size, 20px);
    height: var(--button-icon-size, 20px);
    flex: 0 0 auto;
    fill: none;
    stroke: currentcolor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .filled:not(.eye) {
    fill: currentcolor;
  }

  /* A filled eye becomes a heavy lozenge. Its pupil alone carries the selected state while the familiar eye
     outline stays intact. */
  .filled.eye circle {
    fill: currentcolor;
  }
</style>
