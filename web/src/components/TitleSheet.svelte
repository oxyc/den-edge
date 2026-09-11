<!-- A stand-in for the title's detail page, which will host `TitleActions` the way the TV's does: until it exists,
     a card opens this sheet so the library controls can be reached. -->
<script lang="ts">
  import type { Title } from '../lib/library';
  import type { TitleRow } from '../lib/wire';
  import TitleActions from './TitleActions.svelte';

  let {
    title,
    row,
    busy,
    failure,
    onclose,
    onwatchlist,
    onseen,
    onreact,
  }: {
    title: Title;
    row: TitleRow | undefined;
    busy: boolean;
    failure: string | null;
    onclose: () => void;
    onwatchlist: (on: boolean) => void;
    onseen: (on: boolean) => void;
    onreact: (reaction: TitleRow['reaction']['value']) => void;
  } = $props();

  let dialog: HTMLDialogElement;
  $effect(() => dialog.showModal());

  const poster = $derived(title.posterPath ? `https://image.tmdb.org/t/p/w185${title.posterPath}` : undefined);
</script>

<dialog bind:this={dialog} class="sheet glass" {onclose} aria-labelledby="sheet-title">
  <div class="head">
    {#if poster}<img src={poster} alt="" />{/if}
    <div>
      <h2 id="sheet-title">{title.title}</h2>
      <p class="kind">{[title.type === 'tv' ? 'Series' : 'Movie', title.year].filter(Boolean).join(' · ')}</p>
    </div>
  </div>
  <TitleActions {row} {busy} {failure} {onwatchlist} {onseen} {onreact} />
  <button class="done" onclick={() => dialog.close()}>Done</button>
</dialog>

<style>
  .sheet {
    width: min(480px, calc(100% - 2 * var(--gutter)));
    padding: 24px;
    border-radius: var(--radius);
    color: var(--fg);
  }

  .sheet::backdrop {
    background: rgb(0 0 0 / 0.6);
  }

  .head {
    display: flex;
    gap: 16px;
    align-items: center;
    margin-bottom: 20px;
  }

  img {
    width: 72px;
    border-radius: 8px;
  }

  h2 {
    margin: 0;
    font-size: 20px;
  }

  .kind {
    margin: 4px 0 0;
    color: var(--muted);
  }

  .done {
    margin-top: 8px;
    padding: 10px 16px;
    border: 0;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
</style>
