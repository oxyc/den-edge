<script lang="ts">
  let {
    name,
    filled = false,
  }: {
    name:
      | 'play'
      | 'check'
      | 'eye'
      | 'more'
      | 'sources'
      | 'download'
      | 'like'
      | 'dislike'
      | 'love'
      | 'expand'
      | 'warning'
      | 'gear';
    filled?: boolean;
  } = $props();
</script>

<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" class:filled>
  {#if name === 'play'}<path d="m8 5 11 7-11 7Z" />
  {:else if name === 'check'}<path d="m4 12 5 5L20 6" />
  {:else if name === 'eye'}<path d="M2 12S6 6 12 6s10 6 10 6-4 6-10 6S2 12 2 12Z" /><circle
      cx="12"
      cy="12"
      r="3"
    />
  {:else if name === 'more'}<circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle
      cx="19"
      cy="12"
      r="1"
    />
  {:else if name === 'sources'}<rect x="3" y="4" width="18" height="5" rx="1.5" /><rect
      x="3"
      y="15"
      width="18"
      height="5"
      rx="1.5"
    /><path d="M7 6.5h.01M7 17.5h.01" />
  {:else if name === 'download'}<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4" />
  {:else if name === 'love'}<path
      d="M12 20S3 14.5 3 8.5A4.5 4.5 0 0 1 12 8a4.5 4.5 0 0 1 9 .5C21 14.5 12 20 12 20Z"
    />
  {:else if name === 'expand'}<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
  {:else if name === 'warning'}<path d="M12 4.5 3.2 19.5h17.6L12 4.5Z" /><path
      d="M12 10.5v3.2m0 2.6h.01"
    />
  {:else if name === 'gear'}<circle cx="12" cy="12" r="3.2" /><path
      d="M12 3.2v2.4m0 12.8v2.4M4.8 12H2.4m19.2 0h-2.4M6.9 6.9 5.2 5.2m13.6 13.6-1.7-1.7M17.1 6.9l1.7-1.7M5.2 18.8l1.7-1.7"
    />
  {:else}<g transform={name === 'dislike' ? 'rotate(180 12 12)' : undefined}
      ><path d="M8 20H4V10h4m0 10V10l4-7c2 0 3 1 2 4l-1 3h6c2 0 2 1 2 2l-2 7-1 1H8Z" /></g
    >{/if}
</svg>

<style>
  svg {
    display: block;
    width: 22px;
    height: 22px;
    flex: none;
    fill: none;
    stroke: currentcolor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .filled {
    fill: currentcolor;
  }
</style>
