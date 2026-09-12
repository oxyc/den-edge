<script lang="ts">
  let {
    name,
    filled = false,
  }: {
    name: 'play' | 'check' | 'eye' | 'more' | 'sources' | 'download' | 'like' | 'dislike' | 'love';
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
