<!-- One of the TV's Settings sections (Connections, Playback, Content, …): a heading with the section's own "Expand all",
     its rows on one plate, and the section's footer under it. The rows learn which section they're in from here. -->
<script lang="ts">
  import { setContext, type Snippet } from 'svelte';
  import ExpandAll from './ExpandAll.svelte';
  import { SECTION } from './rows.svelte';

  let {
    id,
    title,
    subtitle,
    footer,
    children,
  }: {
    id: string;
    title: string;
    /** A quieter line under the title, saying what the section is for. */
    subtitle?: string;
    footer?: string;
    children: Snippet;
  } = $props();

  // A section's id doesn't change for the life of the section.
  // svelte-ignore state_referenced_locally
  setContext(SECTION, id);
</script>

<section {id} aria-labelledby="{id}-heading">
  <div class="heading">
    <h2 id="{id}-heading">
      {title}{#if subtitle}<small>{subtitle}</small>{/if}
    </h2>
    <ExpandAll section={id} label={title} />
  </div>
  <div class="plate">{@render children()}</div>
  {#if footer}<p class="footer">{footer}</p>{/if}
</section>

<style>
  section {
    margin-bottom: 40px;
    scroll-margin-top: calc(var(--bar-space) + 64px);
  }

  .heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin: 0 0 10px;
  }

  h2 {
    margin: 0;
    font-size: 20px;
  }

  h2 small {
    display: block;
    color: var(--muted);
    font-size: 13px;
    font-weight: 400;
  }

  .plate {
    display: grid;

    /* An implicit `auto` track honors a control row's min-content width. At 320px, a label beside the
       four-choice subtitle control widened the entire page instead of letting that row wrap. */
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }

  .footer {
    margin: 8px 16px 0;
    color: var(--muted);
    font-size: 13px;
  }
</style>
