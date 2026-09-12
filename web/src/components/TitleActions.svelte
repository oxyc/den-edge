<!-- A title's library controls, as on the TV's detail page: Watchlist, Seen, and the one opinion (Not for me /
     Like / Love). Each press is a "set" the caller writes to the record log.

     One primary action, then a row of glyphs: on a phone every word would wrap the row three deep, so the labels
     are read out rather than drawn until there is room for them. The opinion is one picker, as the player's are:
     the browser opens its own menu, and "No rating" clears it — which pressing the active button twice never said. -->
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
    trailerHref,
    notice = null,
    detailPage = false,
    playLabel = 'Play',
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
    /** A YouTube watch link, or a trailer search when no exact video is known. */
    trailerHref?: string;
    /** What the last action did, when that's worth saying. */
    notice?: string | null;
    detailPage?: boolean;
    playLabel?: string;
  } = $props();
  let viewportWidth = $state(window.innerWidth);

  const active = $derived(row !== undefined && !row.deleted.value);
  const listed = $derived(active && row?.status.value === 'watchlist');
  const seen = $derived(active && row?.status.value === 'watched');
  const reaction = $derived(active ? (row?.reaction.value ?? null) : null);
  const reactions: [Reaction, string][] = [
    ['dislike', 'Not for me'],
    ['like', 'Like'],
    ['love', 'Love'],
  ];
  const rated = $derived(reactions.find(([value]) => value === reaction)?.[1] ?? 'Rate');
</script>

<svelte:window bind:innerWidth={viewportWidth} />

<div class="actions" class:detail-page={detailPage} aria-busy={busy}>
  {#if onplayhere}
    <button class="primary" disabled={busy} onclick={onplayhere}>{@render play()}<span>{playLabel}</span></button>
  {:else if onplay}
    <button class="primary" disabled={busy} onclick={onplay}>{@render tv()}<span>{playLabel === 'Play' ? 'Play on TV' : `${playLabel} on TV`}</span></button>
  {/if}

  <div class="pills">
    {#if trailerHref}
      <!-- A normal link lets iOS hand off to YouTube, with the website as its fallback.
           Avoid a new mobile tab that can be left blank after the app handoff. -->
      <a class="pill trailer" href={trailerHref} target={viewportWidth < 760 ? undefined : '_blank'} rel="noopener noreferrer"
        aria-label="Trailer on YouTube">{@render clapper()}<span>Trailer</span></a>
    {/if}
    {#if onplayhere && onplay}
      <button class="pill" disabled={busy} onclick={onplay}>{@render tv()}<span class="label">Play on TV</span></button>
    {/if}
    <button class="pill" class:on={listed} aria-pressed={listed} disabled={busy} onclick={() => onwatchlist(!listed)}>
      {@render bookmark()}<span class="label">Watchlist</span>
    </button>
    <button class="pill" class:on={seen} aria-pressed={seen} disabled={busy} onclick={() => onseen(!seen)}>
      {@render eye()}<span class="label">Seen</span>
    </button>

    <!-- The select is the control, invisible over the whole pill: the browser opens its own menu — a sheet on a
         phone — and a screen reader reads a pop-up button. -->
    <div class="pick" class:on={reaction !== null}>
      {@render opinion(reaction)}
      <span class="value" aria-hidden="true">{rated}</span>
      {@render chevron()}
      <select
        aria-label="Your opinion"
        value={reaction ?? ''}
        disabled={busy}
        onchange={(event) => onreact((event.currentTarget.value || null) as Reaction | null)}
      >
        <option value="">No rating</option>
        {#each reactions as [value, label] (value)}<option {value}>{label}</option>{/each}
      </select>
    </div>
  </div>
</div>
{#if failure}<p class="failure" role="alert">{failure}</p>{:else if notice}<p class="notice" role="status">{notice}</p>{/if}

{#snippet tv()}
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect x="2.8" y="4.5" width="18.4" height="12.5" rx="2.5" />
    <path d="M8.5 20.5h7" />
    <path d="M10.6 9.4 14.8 11.8l-4.2 2.4V9.4Z" />
  </svg>
{/snippet}

{#snippet play()}
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M8.8 5.6 19 12 8.8 18.4V5.6Z" />
  </svg>
{/snippet}

{#snippet clapper()}
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M3.5 9.6h17v8.4a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V9.6Z" />
    <path d="m3.7 9.6.6-3.2a1 1 0 0 1 1.2-.8l13.2 2.5a1 1 0 0 1 .8 1.2l-.1.3" />
    <path d="m8.6 6.4-.8 3.2M13.2 7.3l-.8 3.2" />
  </svg>
{/snippet}

{#snippet bookmark()}
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M7 4.5h10a1 1 0 0 1 1 1v14l-6-3.7-6 3.7v-14a1 1 0 0 1 1-1Z" />
  </svg>
{/snippet}

{#snippet eye()}
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M2.5 12S6 6.6 12 6.6 21.5 12 21.5 12 18 17.4 12 17.4 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.9" />
  </svg>
{/snippet}

<!-- The opinion is a value, not a toggle, so the glyph is the one that was chosen. -->
{#snippet opinion(value: Reaction | null)}
  {#if value === 'like' || value === 'dislike'}
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g transform={value === 'dislike' ? 'rotate(180 12 12)' : undefined}>
        <path d="M8.6 20.2v-9.8l3.6-6.1a1.3 1.3 0 0 1 2.4.9l-.8 4.3h4.6a2 2 0 0 1 2 2.4l-1.2 6a2 2 0 0 1-2 1.6H8.6Z" />
        <path d="M8.6 20.2H5.9a1.4 1.4 0 0 1-1.4-1.4v-7a1.4 1.4 0 0 1 1.4-1.4h2.7" />
      </g>
    </svg>
  {:else}
    <svg class="icon" class:filled={value === 'love'} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 19.6S4.4 15.1 4.4 10a3.9 3.9 0 0 1 7.6-1.4A3.9 3.9 0 0 1 19.6 10c0 5.1-7.6 9.6-7.6 9.6Z" />
    </svg>
  {/if}
{/snippet}

{#snippet chevron()}
  <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 9.5 6 6 6-6" /></svg>
{/snippet}

<style>
  .detail-page .primary { background:var(--fg); border-color:var(--fg); color:var(--bg); }
  .detail-page .pill, .detail-page .pick { background:rgb(255 255 255 / .09); border-color:rgb(255 255 255 / .13); }
  .detail-page .pill.on, .detail-page .pick.on { background:var(--fg); color:var(--bg); }
  @media(min-width:760px) {
    .detail-page { gap:16px; }
    .detail-page .pills { gap:16px; }
    .detail-page .pick { display:none; }
    .detail-page .primary, .detail-page .pill { padding-inline:20px; border-radius:12px; }
  }

  .actions {
    display: grid;
    gap: 10px;
    margin-bottom: 16px;
    /* No grey flash, and no wait for a double-tap before a tap is passed on, as in the player. */
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }

  .pills {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  /* One height for all of them: a row of capsules at 52, 48 and 44 reads as a mistake rather than a hierarchy,
     which the fill and the width already carry. A finger's worth, either way. */
  .primary,
  .pill,
  .pick {
    display: flex;
    min-height: 48px;
    gap: 8px;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: none;
    color: var(--fg);
    font: inherit;
    cursor: pointer;
    text-decoration: none;
  }

  /* The one thing this page is for: the page's width on a phone. */
  .primary {
    padding: 0 24px;
    border-color: var(--accent);
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }

  /* Under a full-width Play, glyphs of five different widths look like what was left over; they divide the row
     instead, and take their own width once their words are drawn. */
  .pill,
  .pick {
    flex: 1 1 0;
    padding: 0 12px;
  }

  .pick {
    position: relative;
  }

  .trailer { flex:0 0 auto; }

  .on {
    border-color: var(--fg);
    background: var(--fg);
    color: var(--bg);
  }

  .primary:disabled,
  .pill:disabled,
  .pick:has(select:disabled) {
    opacity: 0.6;
    cursor: progress;
  }

  /* The control itself fills the pill — never hidden, which would stop a phone opening it. */
  .pick select {
    position: absolute;
    inset: 0;
    width: 100%;
    padding: 0;
    border: 0;
    opacity: 0;
    appearance: none;
    cursor: pointer;
  }

  /* Where the browser draws the open menu itself, on its own ground. */
  select option {
    color: initial;
  }

  /* Read out at every width, drawn only where there is room: the glyph carries these on a phone. */
  .label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .value {
    display: none;
  }

  @media (max-width: 359px) {
    .pills { gap:6px; }
    .pill, .pick { min-width:44px; padding:0 6px; }
    .trailer { gap:6px; font-size:14px; }
  }

  @media (min-width: 760px) {
    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
    }

    .pill,
    .pick {
      flex: 0 0 auto;
    }

    .chevron {
      display: block;
    }

    .label {
      position: static;
      width: auto;
      height: auto;
      clip-path: none;
    }

    .value {
      display: inline;
    }
  }

  .icon {
    width: 20px;
    height: 20px;
  }

  /* Drawn beside the word it opens; beside a bare glyph it only makes one control wider than its neighbours. */
  .chevron {
    display: none;
    width: 14px;
    height: 14px;
    opacity: 0.6;
  }

  .icon,
  .chevron {
    flex: 0 0 auto;
    fill: none;
    stroke: currentcolor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .icon.filled {
    fill: currentcolor;
  }

  /* The focused element in the picker is the select inside, so the pill lights up with it. */
  .primary:focus-visible,
  .pill:focus-visible,
  .pick:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .failure {
    color: var(--danger);
  }

  .notice {
    color: var(--muted);
  }
</style>
