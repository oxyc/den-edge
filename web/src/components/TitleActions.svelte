<!-- A title's library controls, as on the TV's detail page: Watchlist, Seen, and the one opinion (Not for me /
     Like / Love). Each press is a "set" the caller writes to the record log.

     One primary action, then a row of glyphs: on a phone every word would wrap the row three deep, so the labels
     are read out rather than drawn until there is room for them. The opinion is one picker, as the player's are:
     the browser opens its own menu, and "No rating" clears it — which pressing the active button twice never said. -->
<script lang="ts">
  import Button from './Button.svelte';
  import ButtonIcon from './ButtonIcon.svelte';
  import SplitButton from './SplitButton.svelte';
  import type { TitleRow } from '../lib/wire';
  import { shareOrCopy } from '../lib/share';
  import { titleState, type Reaction } from '../lib/titleState';
  import { toastContext } from '../lib/toast';

  let {
    row,
    busy,
    failure,
    onwatchlist,
    onseen,
    onreact,
    onplay,
    onplayhere,
    away = false,
    blocked = false,
    restricted = false,
    trailerHref,
    ontrailer,
    share,
    notice = null,
    detailPage = false,
    playLabel = 'Play',
    compact = false,
    seenOverride = undefined,
  }: {
    /** The title's row as last read; undefined for a title the library has never held. */
    row: TitleRow | undefined;
    busy: boolean;
    failure: string | null;
    onwatchlist: (on: boolean) => void;
    onseen: (on: boolean) => void;
    /** Set the opinion; no picker without it. */
    onreact?: (reaction: Reaction | null) => void;
    /** Play it on the linked TV; no button without it. */
    onplay?: () => void;
    /** Play it in this browser; no button without it. */
    onplayhere?: () => void;
    /**
     * This device reaches no route to Den's player — away from home, without Tailscale — so there is no Play here: said
     * plainly under the actions, rather than leaving the button's absence to explain itself.
     */
    away?: boolean;
    /**
     * The browser itself refused the home network (`localNetworkRefused`), rather than no route reaching the player.
     * Said apart, because the other sentence sends someone who is already on Tailscale to go and check Tailscale.
     */
    blocked?: boolean;
    /** The parental ceiling blocks this title: no Play, no Trailer, and a line saying why instead. */
    restricted?: boolean;
    /** A YouTube watch link, or a trailer search when no exact video is known. */
    trailerHref?: string;
    /**
     * Play the trailer here, in YouTube's embed, instead of leaving the page for it.
     *
     * Absent — a title TMDB lists no trailer id for — the link below stands on its own and searches
     * YouTube instead. The href stays either way, so a middle-click or a long press still opens the
     * real thing in a tab.
     */
    ontrailer?: () => void;
    /** What to hand the share sheet, or copy: this title and the link that opens it. No button without it. */
    share?: { title: string; url: string };
    /** What the last action did, when that's worth saying. */
    notice?: string | null;
    detailPage?: boolean;
    playLabel?: string;
    /**
     * Glyphs only, each named for what pressing it does ("Add to watchlist", "Mark as seen"): the billboard's
     * slide, which has its own Play and More beside them and no room for words.
     */
    compact?: boolean;
    /**
     * The series "Seen" pill, when the caller knows the episode layout and it disagrees with the title's own
     * bare flag (den-edge#258): a series can read `watched` on its row — the TV's Watchlist "Mark Watched"
     * writes only that, never the episodes — while none of its episodes carry a mark. den-core's own policy
     * already treats the episodes as authoritative once the layout is known (`continue_entry`'s "where the
     * layout is known, the episodes decide"); this pill follows the same rule rather than the raw flag, so it
     * can never read Seen over an episode list showing nothing watched.
     */
    seenOverride?: boolean;
  } = $props();
  let viewportWidth = $state(window.innerWidth);
  /** Said on the button itself, where the link was copied rather than handed to a sheet that says so. */
  let copied = $state(false);
  let copiedFor: ReturnType<typeof setTimeout> | undefined;
  const notify = toastContext();

  async function shareTitle() {
    if (!share) return;
    const result = await shareOrCopy(share);
    if (result !== 'copied') return;
    copied = true;
    clearTimeout(copiedFor);
    copiedFor = setTimeout(() => (copied = false), 2000);
    // The visible word on the button changes too, but a live region INSIDE the button it's read from is
    // announced inconsistently (VoiceOver often says nothing) — the page toast is what actually speaks it.
    notify?.('Link copied');
  }

  const { listed, seen: flagSeen, reaction } = $derived(titleState(row));
  const seen = $derived(seenOverride ?? flagSeen);
  const reactions: [Reaction, string][] = [
    ['dislike', 'Not for me'],
    ['like', 'Like'],
    ['love', 'Love'],
  ];
  const rated = $derived(reactions.find(([value]) => value === reaction)?.[1] ?? 'Rate');
</script>

<svelte:window bind:innerWidth={viewportWidth} />

<div class="actions" class:detail-page={detailPage} class:compact aria-busy={busy}>
  {#if restricted}
    <!-- The ceiling's own slot, where Play would be: the title is still named and rated on the page, but
         nothing here starts it. The TV says the same thing in the same place. -->
    <p class="restricted" role="status">
      {@render lock()}<span>Blocked by parental controls</span>
    </p>
  {:else if onplayhere}
    {#if onplay}
      <SplitButton
        icon="play"
        label={playLabel}
        onclick={onplayhere}
        alternateIcon="tv"
        alternateLabel={playLabel === 'Play' ? 'Play on TV' : `${playLabel} on TV`}
        onalternate={onplay}
        menuId="play-destinations"
        {busy}
      />
    {:else}
      <Button
        variant="primary"
        size="large"
        class="main-action"
        icon="play"
        label={playLabel}
        {busy}
        onclick={onplayhere}
      />
    {/if}
  {:else if onplay}
    <Button
      variant="primary"
      size="large"
      class="main-action"
      icon="tv"
      label={playLabel === 'Play' ? 'Play on TV' : `${playLabel} on TV`}
      {busy}
      onclick={onplay}
    />
  {/if}

  <div class="pills">
    <div class="promoted">
      {#if trailerHref && !restricted && ontrailer}
        <!-- A real button: the plain click always opens the in-page dialog, so it must be announced as
             something that acts in place rather than as a link that leaves the page. -->
        <Button
          variant="secondary"
          size="large"
          class="pill trailer"
          icon="trailer"
          label="Trailer"
          ariaLabel="Trailer"
          onclick={ontrailer}
        />
      {:else if trailerHref && !restricted}
        <!-- No trailer id to play in a dialog: a normal link, which really does leave for YouTube. A normal
             link also lets iOS hand off to its app, with the website as its fallback. Avoid a new mobile tab
             that can be left blank after the app handoff. -->
        <a
          class="den-button den-button-secondary den-button-large pill trailer"
          href={trailerHref}
          target={viewportWidth < 760 ? undefined : '_blank'}
          rel="noopener noreferrer"
          aria-label="Trailer on YouTube"
          ><ButtonIcon name="trailer" /><span class="den-button-label">Trailer</span></a
        >
      {/if}
    </div>

    <div class="utilities">
      <!-- Compact, the name says what a press does and the fill says the state: a pressed toggle whose name
           changed with it would be read out as the opposite of what it is. -->
      <Button
        variant="stateful"
        class={listed ? 'pill on' : 'pill'}
        icon="bookmark"
        iconFilled={listed}
        label={compact ? undefined : 'Watchlist'}
        pressed={compact ? undefined : listed}
        ariaLabel={compact ? (listed ? 'Remove from watchlist' : 'Add to watchlist') : 'Watchlist'}
        {busy}
        onclick={() => onwatchlist(!listed)}
      />
      <Button
        variant="stateful"
        class={seen ? 'pill on' : 'pill'}
        icon="eye"
        iconFilled={seen}
        label={compact ? undefined : 'Seen'}
        pressed={compact ? undefined : seen}
        ariaLabel={compact ? (seen ? 'Mark as unseen' : 'Mark as seen') : 'Seen'}
        {busy}
        onclick={() => onseen(!seen)}
      />
      {#if share}
        <Button
          variant="tertiary"
          class="pill share"
          icon="share"
          label={copied ? 'Link copied' : 'Share'}
          ariaLabel={copied ? 'Link copied' : 'Share'}
          {busy}
          onclick={() => void shareTitle()}
        />
      {/if}

      <!-- The select is the control, invisible over the whole pill: the browser opens its own menu — a sheet on a
           phone — and a screen reader reads a pop-up button. -->
      {#if onreact}
        <div
          class="den-button den-button-secondary den-button-regular pick"
          class:on={reaction !== null}
        >
          {@render opinion(reaction)}
          <span class="value" aria-hidden="true">{rated}</span>
          <span class="chevron"><ButtonIcon name="chevron" /></span>
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
      {/if}
    </div>
  </div>
</div>
{#if failure}<p class="failure" role="alert">{failure}</p>{:else if notice}<p
    class="notice"
    role="status"
  >
    {notice}
  </p>{:else if away && !onplayhere}<p class="notice">
    {#if blocked}
      This browser is blocking Den from reaching your home network, so it cannot play here. Allow
      local network access for this site, then reload.
    {:else}
      Playback works on your home network or with Tailscale on this device.
    {/if}
  </p>{/if}

{#snippet lock()}
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect x="5" y="10.4" width="14" height="9.6" rx="2.2" />
    <path d="M8.2 10.4V7.9a3.8 3.8 0 0 1 7.6 0v2.5" />
  </svg>
{/snippet}

<!-- The opinion is a value, not a toggle, so the glyph is the one that was chosen. -->
{#snippet opinion(value: Reaction | null)}
  {#if value === 'like' || value === 'dislike'}
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g transform={value === 'dislike' ? 'rotate(180 12 12)' : undefined}>
        <path
          d="M8.6 20.2v-9.8l3.6-6.1a1.3 1.3 0 0 1 2.4.9l-.8 4.3h4.6a2 2 0 0 1 2 2.4l-1.2 6a2 2 0 0 1-2 1.6H8.6Z"
        />
        <path d="M8.6 20.2H5.9a1.4 1.4 0 0 1-1.4-1.4v-7a1.4 1.4 0 0 1 1.4-1.4h2.7" />
      </g>
    </svg>
  {:else}
    <svg
      class="icon"
      class:filled={value === 'love'}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M12 19.6S4.4 15.1 4.4 10a3.9 3.9 0 0 1 7.6-1.4A3.9 3.9 0 0 1 19.6 10c0 5.1-7.6 9.6-7.6 9.6Z"
      />
    </svg>
  {/if}
{/snippet}

<style>
  .actions {
    display: grid;
    gap: 10px;
    margin-bottom: 16px;
  }

  .pills {
    display: grid;
    gap: 10px;
  }

  /* Availability must not determine the phone's row geometry. Playback choices are words in a two-column row;
     personal utilities are a separate equal-width glyph row whose accessible names never depend on those words. */
  .promoted,
  .utilities {
    display: grid;
    gap: 10px;
  }

  .promoted {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .promoted:empty {
    display: none;
  }

  .promoted > :only-child {
    grid-column: 1 / -1;
  }

  .utilities {
    grid-template-columns: repeat(auto-fit, minmax(44px, 1fr));
  }

  .actions > :global(.main-action),
  .promoted > :global(.pill),
  .utilities > :global(.pill),
  .pick {
    width: 100%;
  }

  .promoted :global(.den-button-label) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pick {
    position: relative;

    /* The oddity tapping it looked like: iOS showing a text-selection caret/loupe over the value and glyph,
       which sit, as plain text and an SVG, under the invisible `<select>` that actually takes the tap. */
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }

  .pick.on {
    border-color: var(--fg);
    background: var(--fg);
    color: var(--bg);
  }

  /* Four quiet, equal tap targets on a phone: state belongs to the glyph and a restrained tint, not a row of
     permanent cards. Focus remains the shared high-contrast ring, while hover/press briefly reveals the target. */
  @media (width < 760px) {
    .utilities > :global(.pill),
    .utilities > .pick {
      --button-bg: transparent;
      --button-border: transparent;
      --button-fg: var(--muted);
    }

    .utilities > :global(.pill[aria-pressed='true']),
    .utilities > .pick.on {
      --button-bg: color-mix(in srgb, var(--accent) 14%, transparent);
      --button-border: transparent;
      --button-fg: color-mix(in srgb, var(--fg) 78%, var(--accent));

      background: var(--button-bg);
      color: var(--button-fg);
    }
  }

  /* The focused element in the picker is the select inside, so its shell lights up with it. */
  .pick:focus-within {
    outline: 3px solid color-mix(in srgb, var(--accent) 82%, white);
    outline-offset: 3px;
  }

  /* The select stays a real `disabled`; ordinary buttons use focus-preserving `aria-disabled` in Button. */
  .pick:has(select:disabled) {
    opacity: 0.45;
    cursor: progress;
  }

  /* The control itself fills the pill — never hidden, which would stop a phone opening it. */
  .pick select {
    position: absolute;
    inset: -1px;
    width: calc(100% + 2px);
    height: calc(100% + 2px);
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
  .utilities :global(.den-button-label) {
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

  .icon {
    width: 20px;
    height: 20px;
    flex: 0 0 auto;
    fill: none;
    stroke: currentcolor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Drawn beside the word it opens; beside a bare glyph it only makes one control wider than its neighbours. */
  .chevron {
    --button-icon-size: 14px;

    display: none;
    opacity: 0.6;
  }

  .icon.filled {
    fill: currentcolor;
  }

  .failure {
    color: var(--danger);
  }

  /* Bare glyphs beside the billboard's own buttons: no ring and no fill, so they don't compete with Play and
     More. The shadow keeps them legible over a bright frame; the state is the glyph filling in, and a pointer
     or the keyboard lights up the round target around it. The line saying a press didn't save takes a row of
     its own beneath them. */
  .compact {
    display: flex;
    gap: 2px;
    margin-bottom: 0;
  }

  .compact .pills,
  .compact .utilities {
    display: flex;
    gap: 2px;
  }

  .compact .promoted {
    display: none;
  }

  .compact :global(.pill),
  .compact :global(.pill.on) {
    flex: 0 0 auto;
    width: 48px;
    padding: 0;
    border-color: transparent;
    background: none;
    color: var(--fg);
    filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.8));
    transition: background-color 0.15s ease;
  }

  .compact :global(.pill:focus-visible),
  .compact :global(.pill:hover:not([aria-disabled='true'])) {
    background: rgb(255 255 255 / 0.16);
  }

  @media (prefers-reduced-motion: reduce) {
    .compact :global(.pill) {
      transition: none;
    }
  }

  .compact + .failure {
    flex-basis: 100%;
    margin: 0;
    font-weight: 600;
    text-shadow: 0 1px 2px rgb(0 0 0 / 0.8);
  }

  .notice {
    color: var(--muted);
  }

  /* Where Play would be, reading as a statement rather than a control: nothing here is pressable. */
  .restricted {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 0;
    color: var(--muted);
    font-weight: 600;
  }

  @media (width <= 359px) {
    .pills,
    .promoted,
    .utilities {
      gap: 6px;
    }

    .promoted > :global(.pill) {
      padding-inline: 10px;
      font-size: 14px;
    }

    .utilities > :global(.pill),
    .pick {
      padding-inline: 6px;
    }
  }

  @media (width >= 760px) {
    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
    }

    .pills,
    .promoted,
    .utilities {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .actions > :global(.main-action),
    .promoted > :global(.pill),
    .utilities > :global(.pill),
    .pick {
      width: auto;
    }

    .utilities > :global(.share) {
      --button-bg: transparent;
      --button-border: transparent;
      --button-fg: var(--muted);
    }

    .chevron {
      display: block;
    }

    .utilities :global(.den-button-label) {
      position: static;
      width: auto;
      height: auto;
      clip-path: none;
    }

    .value {
      display: inline;
    }

    .detail-page {
      gap: 16px;
    }

    .detail-page .pills,
    .detail-page .promoted,
    .detail-page .utilities {
      gap: 16px;
    }

    .detail-page .pick {
      display: none;
    }

    .detail-page :global(.main-action),
    .detail-page :global(.pill) {
      padding-inline: 20px;
      border-radius: 12px;
    }
  }
</style>
