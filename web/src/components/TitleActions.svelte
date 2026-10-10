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
  import { PressedTitle } from '../lib/pressedTitle.svelte';
  import type { SaveKind } from '../lib/pressedTitleState';
  import type { Reaction } from '../lib/titleState';
  import { toastContext } from '../lib/toast';
  import { tick } from 'svelte';

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
    onwatchlist: (on: boolean) => void | Promise<unknown>;
    onseen: (on: boolean) => void | Promise<unknown>;
    /** Set the opinion; no picker without it. */
    onreact?: (reaction: Reaction | null) => void | Promise<unknown>;
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

  // A press shows at once and is saved after. Library writes share one command channel (and Watchlist/Seen share one
  // status field), so they serialize: the initiator says busy; its peers stay visibly stable but honestly expose that
  // they cannot be changed yet. The press stays laid over `row` until its own save ends, so the row refreshing
  // meanwhile never moves the button back; a save that fails is simply no longer laid over the row, which is the
  // state it had.
  const pressed = new PressedTitle();
  const externallyBusy = () => busy && pressed.idle;
  const mutationBlocked = () => busy || !pressed.idle;

  async function save(
    kind: SaveKind,
    value: boolean | Reaction | null,
    action: () => void | Promise<unknown>,
    button?: Reaction,
  ) {
    if (mutationBlocked()) return;
    pressed.begin(kind, value, button);
    try {
      await action();
    } finally {
      // Once the row has taken what the save made of it.
      await tick();
      pressed.end();
    }
  }

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

  const { listed, seen: flagSeen, reaction } = $derived(pressed.state(row));
  // The series pill follows its episodes, until Seen itself is pressed: that press is what it reads as meanwhile.
  const seen = $derived(pressed.saving('seen') ? flagSeen : (seenOverride ?? flagSeen));
  const reactions: [Reaction, string][] = [
    ['dislike', 'Not for me'],
    ['like', 'Like'],
    ['love', 'Love'],
  ];
  const rated = $derived(reactions.find(([value]) => value === reaction)?.[1] ?? 'Rate');
  const opinionIcon = (value: Reaction | null) =>
    value === 'dislike' ? 'thumb-down' : value === 'like' ? 'thumb-up' : 'heart';
</script>

<svelte:window bind:innerWidth={viewportWidth} />

<div
  class="actions"
  class:detail-page={detailPage}
  class:compact
  class:saving={!pressed.idle}
  aria-busy={busy || !pressed.idle}
>
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
        busy={externallyBusy()}
      />
    {:else}
      <Button
        variant="primary"
        size="large"
        class="main-action"
        icon="play"
        label={playLabel}
        busy={externallyBusy()}
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
      busy={externallyBusy()}
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
        busy={pressed.saving('watchlist')}
        saving={pressed.saving('watchlist')}
        aria-disabled={mutationBlocked() || undefined}
        onclick={() => {
          const on = !listed;
          void save('watchlist', on, () => onwatchlist(on));
        }}
      />
      <Button
        variant="stateful"
        class={seen ? 'pill on' : 'pill'}
        icon="eye"
        iconFilled={seen}
        label={compact ? undefined : 'Seen'}
        pressed={compact ? undefined : seen}
        ariaLabel={compact ? (seen ? 'Mark as unseen' : 'Mark as seen') : 'Seen'}
        busy={pressed.saving('seen')}
        saving={pressed.saving('seen')}
        aria-disabled={mutationBlocked() || undefined}
        onclick={() => {
          const on = !seen;
          void save('seen', on, () => onseen(on));
        }}
      />
      {#if onreact}
        <div class="desktop-reactions" role="group" aria-label="Your opinion">
          {#each reactions as [value, label] (value)}
            <Button
              variant="tertiary"
              class={`reaction-option reaction-${value}${reaction === value ? ' selected' : ''}`}
              icon={opinionIcon(value)}
              iconFilled={reaction === value}
              {label}
              pressed={reaction === value}
              busy={pressed.saving('reaction', value)}
              saving={pressed.saving('reaction', value)}
              aria-disabled={mutationBlocked() || undefined}
              onclick={() => {
                const next = reaction === value ? null : value;
                void save('reaction', next, () => onreact(next), value);
              }}
            />
          {/each}
        </div>
      {/if}

      {#if share}
        <Button
          variant="tertiary"
          class="pill share"
          icon="share"
          label={copied ? 'Link copied' : 'Share'}
          ariaLabel={copied ? 'Link copied' : 'Share'}
          busy={externallyBusy()}
          onclick={() => void shareTitle()}
        />
      {/if}

      <!-- The select is the control, invisible over the whole pill: the browser opens its own menu — a sheet on a
           phone — and a screen reader reads a pop-up button. -->
      {#if onreact}
        <div
          class="den-button den-button-secondary den-button-regular pick"
          class:on={reaction !== null}
          aria-busy={pressed.saving('reaction') || undefined}
          data-saving={pressed.saving('reaction') || undefined}
        >
          <ButtonIcon name={opinionIcon(reaction)} filled={reaction !== null} />
          <span class="value" aria-hidden="true">{rated}</span>
          <span class="chevron"><ButtonIcon name="chevron" /></span>
          <select
            aria-label="Your opinion"
            value={reaction ?? ''}
            disabled={mutationBlocked()}
            onchange={(event) => {
              const next = (event.currentTarget.value || null) as Reaction | null;
              void save('reaction', next, () => onreact(next));
            }}
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

  .desktop-reactions {
    display: none;
  }

  /* Four quiet, equal tap targets on a phone: state belongs to the glyph and a restrained tint, not a row of
     permanent cards. Focus remains the shared high-contrast ring, while hover/press briefly reveals the target. */
  @media (width < 760px) {
    .detail-page .pills {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
    }

    .detail-page .promoted {
      display: flex;
      flex: 0 0 auto;
    }

    .detail-page .promoted > :global(.pill) {
      width: auto;
    }

    .detail-page .utilities {
      display: flex;
      flex: 0 0 auto;
      flex-wrap: nowrap;
      justify-content: space-between;
      gap: 0;
      width: auto;
    }

    .detail-page .utilities > :global(.pill),
    .detail-page .utilities > .pick {
      --button-bg: transparent;
      --button-border: transparent;
      --button-fg: var(--muted);

      flex: 0 0 44px;
      width: 44px;
      padding: 0;
    }

    .detail-page .utilities > :global(.pill[aria-pressed='true']),
    .detail-page .utilities > .pick.on {
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

  /* A local save changes only its initiating state glyph. The shared command channel temporarily disables the
     other mutations, but dimming the whole row made one Watchlist press look like a full action-bar rerender. */
  .actions.saving :global(.den-button[aria-disabled='true']),
  .actions.saving .pick:has(select:disabled) {
    opacity: 1;
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
    gap: 6px;
  }

  .compact .promoted {
    display: none;
  }

  .compact :global(.pill),
  .compact :global(.pill.on) {
    flex: 0 0 auto;
    width: 48px;
    min-height: 48px;
    padding: 0;
    border-color: transparent;
    background: none;
    color: var(--fg);
    filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.8));
    transition: background-color 0.15s ease;
  }

  .compact :global(.pill:focus-visible) {
    background: rgb(255 255 255 / 0.16);
  }

  @media (hover: hover) and (pointer: fine) {
    .compact :global(.pill:hover:not([aria-disabled='true'])) {
      background: rgb(255 255 255 / 0.16);
    }
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
    .detail-page .pills {
      gap: 6px;
    }

    .promoted > :global(.pill) {
      padding-inline: 10px;
      font-size: 14px;
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

    .detail-page .pick {
      display: none;
    }

    .actions:not(.compact) > :global(.main-action),
    .actions:not(.compact) .promoted > :global(.pill),
    .actions:not(.compact) .utilities > :global(.pill),
    .actions:not(.compact) .pick {
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
      /* On desktop these wrappers carry semantics/conditional content, not layout. Their controls participate in
         one wrapping action row, so a narrow viewport gets a clean core row and an atomic reactions + Share row. */
      display: contents;
    }

    .detail-page .utilities > :global(.share) {
      margin-left: auto;
    }

    /* Opinions stay in the action row without becoming three more button boxes. The group may wrap as one
       object when copy or localization needs room; its individual choices never split across lines. */
    .detail-page .desktop-reactions {
      display: flex;
      flex: 0 0 auto;
      flex-wrap: nowrap;
      gap: 4px;
    }

    .detail-page .desktop-reactions :global(.reaction-option) {
      --button-bg: transparent;
      --button-border: transparent;
      --button-fg: var(--muted);

      min-height: 44px;
      padding-inline: 8px;
      border: 0;
      background: transparent;
      font-size: 14px;
      font-weight: 600;
    }

    @media (hover: hover) and (pointer: fine) {
      .detail-page .desktop-reactions :global(.reaction-option:hover:not([aria-disabled='true'])) {
        border-color: transparent;
        background: transparent;
        color: var(--fg);
      }
    }

    .detail-page .desktop-reactions :global(.reaction-option.selected) {
      background: transparent;
    }

    .detail-page .desktop-reactions :global(.reaction-option.reaction-dislike.selected) {
      color: #ffa251;
    }

    .detail-page .desktop-reactions :global(.reaction-option.reaction-like.selected) {
      color: #75d698;
    }

    .detail-page .desktop-reactions :global(.reaction-option.reaction-love.selected) {
      color: #ff6b80;
    }

    .detail-page :global(.main-action),
    .detail-page :global(.pill) {
      padding-inline: 20px;
      border-radius: 12px;
    }
  }
</style>
