<!-- A title's library controls, as on the TV's detail page: Watchlist, Seen, and the one opinion (Not for me /
     Like / Love). Each press is a "set" the caller writes to the record log. -->
<script lang="ts">
  import type { TitleRow } from '../lib/wire';

  type Reaction = NonNullable<TitleRow['reaction']['value']>;

  let {
    row,
    busy,
    failure,
    onwatchlist,
    onseen,
    onreact,
    onplay,
    onplayhere,
    notice = null,
  }: {
    /** The title's row as last read; undefined for a title the library has never held. */
    row: TitleRow | undefined;
    busy: boolean;
    failure: string | null;
    onwatchlist: (on: boolean) => void;
    onseen: (on: boolean) => void;
    onreact: (reaction: Reaction | null) => void;
    /** Play it on the linked TV; no button without it. */
    onplay?: () => void;
    /** Play it in this browser; no button without it. */
    onplayhere?: () => void;
    /** What the last action did, when that's worth saying. */
    notice?: string | null;
  } = $props();

  const active = $derived(row !== undefined && !row.deleted.value);
  const listed = $derived(active && row?.status.value === 'watchlist');
  const seen = $derived(active && row?.status.value === 'watched');
  const reaction = $derived(active ? (row?.reaction.value ?? null) : null);
  const reactions: [Reaction, string][] = [
    ['dislike', 'Not for me'],
    ['like', 'Like'],
    ['love', 'Love'],
  ];
</script>

<div class="actions">
  {#if onplayhere}<button class="play" disabled={busy} onclick={onplayhere}>Play</button>{/if}
  {#if onplay}<button class:play={!onplayhere} disabled={busy} onclick={onplay}>Play on TV</button>{/if}
  <button class:on={listed} aria-pressed={listed} disabled={busy} onclick={() => onwatchlist(!listed)}>
    {listed ? 'On your watchlist' : 'Add to watchlist'}
  </button>
  <button class:on={seen} aria-pressed={seen} disabled={busy} onclick={() => onseen(!seen)}>
    {seen ? 'Seen' : 'Mark as seen'}
  </button>
</div>
<div class="actions" role="group" aria-label="Your opinion">
  {#each reactions as [value, label] (value)}
    <button
      class:on={reaction === value}
      aria-pressed={reaction === value}
      disabled={busy}
      onclick={() => onreact(reaction === value ? null : value)}>{label}</button
    >
  {/each}
</div>
{#if failure}<p class="failure" role="alert">{failure}</p>{:else if notice}<p class="notice" role="status">{notice}</p>{/if}

<style>
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 12px;
  }

  button {
    padding: 10px 16px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: none;
    color: var(--fg);
    cursor: pointer;
  }

  button.on {
    border-color: var(--fg);
    background: var(--fg);
    color: var(--bg);
    font-weight: 600;
  }

  button:disabled {
    opacity: 0.6;
    cursor: progress;
  }

  button.play {
    border-color: var(--accent);
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }

  .failure {
    color: var(--danger);
  }

  .notice {
    color: var(--muted);
  }
</style>
