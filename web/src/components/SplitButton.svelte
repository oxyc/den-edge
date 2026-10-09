<!-- One primary action with a less common alternate destination. The alternate is disclosed as a real menu:
     it costs no permanent chrome, while keyboard and assistive-technology users get the same two choices. -->
<script lang="ts">
  import { tick } from 'svelte';
  import Button from './Button.svelte';
  import type { ButtonIconName } from './ButtonIcon.svelte';

  let {
    label,
    icon,
    onclick,
    alternateLabel,
    alternateIcon,
    onalternate,
    menuId,
    busy = false,
  }: {
    label: string;
    icon?: ButtonIconName;
    onclick: () => void;
    alternateLabel: string;
    alternateIcon?: ButtonIconName;
    onalternate: () => void;
    menuId: string;
    busy?: boolean;
  } = $props();

  let root = $state<HTMLDivElement>();
  let trigger = $state<HTMLButtonElement>();
  let alternate = $state<HTMLButtonElement>();
  let open = $state(false);
  let pointerOpen = $state(false);
  let focusCheck: ReturnType<typeof setTimeout> | undefined;

  async function show(focusAlternate = true) {
    if (busy) return;
    open = true;
    if (!focusAlternate) return;
    await tick();
    alternate?.focus();
  }

  function hide(returnFocus = false) {
    open = false;
    pointerOpen = false;
    if (returnFocus) trigger?.focus();
  }

  function toggle(event: MouseEvent) {
    // Keyboard and assistive-technology activation (`detail === 0`) enter the disclosed menu. A real pointer
    // keeps focus on the disclosure, avoiding WebKit's touch focus halo; its second tap closes and clears that
    // pointer focus instead of leaving a keyboard-looking ring behind.
    const fromPointer = event.detail > 0;
    if (open) {
      hide(!fromPointer);
      if (fromPointer) trigger?.blur();
      return;
    }
    pointerOpen = fromPointer;
    void show(!fromPointer);
  }

  function chooseAlternate() {
    hide();
    onalternate();
  }

  function leave(event: FocusEvent) {
    if (!open || root?.contains(event.relatedTarget as Node | null)) return;
    // WebKit reports `relatedTarget = null` while a touch moves from the menu item back to its disclosure.
    // Closing synchronously there made the following click see a closed menu and reopen it. Let the complete tap
    // settle; `hide(true)` has then returned focus to the disclosure, while a real Tab away remains outside.
    clearTimeout(focusCheck);
    focusCheck = setTimeout(() => {
      if (open && !root?.contains(document.activeElement)) hide();
    });
  }

  $effect(() => () => clearTimeout(focusCheck));

  $effect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root?.contains(event.target as Node)) hide();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      hide(true);
    };
    document.addEventListener('pointerdown', outside, { capture: true });
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside, { capture: true });
      document.removeEventListener('keydown', escape);
    };
  });
</script>

<div
  class="split-button"
  class:open
  class:pointer-open={pointerOpen}
  bind:this={root}
  onfocusout={leave}
>
  <div class="split-surface" class:busy class:open>
    <Button
      variant="primary"
      size="large"
      class="split-region split-main"
      {icon}
      {label}
      {busy}
      {onclick}
      onkeydown={() => (pointerOpen = false)}
    />
    <span class="split-divider" aria-hidden="true"></span>
    <Button
      bind:element={trigger}
      variant="primary"
      size="large"
      class="split-region split-toggle"
      icon="chevron"
      ariaLabel={`More ways to ${label.toLowerCase()}`}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={menuId}
      {busy}
      onclick={toggle}
      onkeydown={(event) => {
        pointerOpen = false;
        if (event.key !== 'ArrowDown') return;
        event.preventDefault();
        pointerOpen = false;
        void show();
      }}
    />
  </div>
  {#if open}
    <div class="split-menu" id={menuId} role="menu">
      <Button
        bind:element={alternate}
        variant="menu"
        class="split-alternate"
        icon={alternateIcon}
        label={alternateLabel}
        role="menuitem"
        {busy}
        onclick={chooseAlternate}
        onkeydown={() => (pointerOpen = false)}
      />
    </div>
  {/if}
</div>

<style>
  .split-button {
    --split-expanded-edge: color-mix(in srgb, var(--bg) 18%, var(--fg));

    position: relative;
    display: block;
    width: 100%;
    min-width: 0;
  }

  /* Open, the trigger and its destination are one stacked object. The shadow belongs to that complete
     silhouette—not separately to a light button and a dark floating card—and a local stacking level keeps the
     absolute drawer above the action row it intentionally overlays. */
  .split-button.open {
    z-index: 8;
    filter: drop-shadow(0 12px 24px rgb(0 0 0 / 0.42));
  }

  /* The surface is one object. Its two real buttons are only semantic hit regions inside it, so the seam can
     never become two adjacent pills; clipping belongs to this inner surface while the menu remains its sibling. */
  .split-surface {
    display: flex;
    width: 100%;
    min-height: 48px;
    overflow: hidden;
    border: 1px solid var(--fg);
    border-radius: 12px;
    background: var(--fg);
    color: var(--bg);
    box-shadow:
      0 1px 2px rgb(0 0 0 / 0.24),
      inset 0 1px 0 rgb(255 255 255 / 0.18);
    cursor: pointer;
    transition: opacity 120ms ease;
  }

  .split-surface.open {
    border-color: var(--split-expanded-edge);
    border-radius: 12px 12px 0 0;
    box-shadow: none;
  }

  /* The shell stays visually stable. Focus identifies the single control, and the light region fill says which
     of its two semantic buttons owns keyboard focus without turning either region into a second pill. */
  .split-button:not(.pointer-open) .split-surface:has(:global(.split-region:focus-visible)) {
    outline: 3px solid color-mix(in srgb, var(--accent) 82%, white);
    outline-offset: 3px;
  }

  .split-surface.busy {
    opacity: 0.56;
    cursor: progress;
  }

  .split-surface :global(.den-button.split-region) {
    --button-bg: transparent;
    --button-border: transparent;
    --button-fg: var(--bg);

    min-height: 46px;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    color: var(--bg);
    cursor: inherit;
  }

  .split-button:not(.pointer-open) .split-surface :global(.den-button.split-region:focus-visible) {
    outline: 0;
    outline-offset: 0;
    background: color-mix(in srgb, var(--fg) 72%, white);
  }

  .split-surface :global(.den-button.split-region[aria-disabled='true']) {
    opacity: 1;
  }

  .split-surface :global(.den-button.split-main) {
    flex: 1 1 auto;
    padding-inline: 20px;
  }

  .split-surface :global(.den-button.split-toggle) {
    --button-icon-size: 16px;

    flex: 0 0 48px;
    width: 48px;
    padding: 0;
  }

  .split-divider {
    flex: 0 0 1px;
    align-self: stretch;
    margin-block: 10px;
    background: color-mix(in srgb, var(--bg) 16%, transparent);
    pointer-events: none;
  }

  .split-surface :global(.split-toggle svg[data-icon='chevron']) {
    transition: transform 120ms ease;
  }

  .split-surface.open :global(.split-toggle svg[data-icon='chevron']) {
    transform: rotate(180deg);
  }

  @media (hover: hover) and (pointer: fine) {
    .split-surface :global(.den-button.split-main:hover:not([aria-disabled='true'])),
    .split-surface:not(.open) :global(.den-button.split-toggle:hover:not([aria-disabled='true'])) {
      background: color-mix(in srgb, var(--fg) 72%, white);
      border-color: transparent;
    }
  }

  .split-surface :global(.den-button.split-region:active:not([aria-disabled='true'])) {
    background: color-mix(in srgb, var(--fg) 86%, var(--bg));
    transform: none;
  }

  .split-surface :global(.den-button.split-main:focus-visible svg[data-icon='play']),
  .split-surface
    :global(.den-button.split-main:active:not([aria-disabled='true']) svg[data-icon='play']) {
    fill: currentcolor;
  }

  @media (hover: hover) and (pointer: fine) {
    .split-surface
      :global(.den-button.split-main:hover:not([aria-disabled='true']) svg[data-icon='play']) {
      fill: currentcolor;
    }
  }

  .split-menu {
    position: absolute;
    inset: 100% 0 auto;
    padding: 0;
    border: 1px solid var(--split-expanded-edge);
    border-top: 0;
    border-radius: 0 0 12px 12px;
    background: color-mix(in srgb, var(--fg) 96%, var(--bg));
    animation: reveal-destination 120ms ease-out;
  }

  .split-menu :global(.den-button.split-alternate) {
    --button-bg: transparent;
    --button-border: transparent;
    --button-fg: var(--bg);
    --button-icon-size: 18px;

    min-height: 48px;
    padding-inline: 14px;
    color: var(--bg);
    font-size: 14px;
    font-weight: 600;
  }

  .split-menu :global(.den-button.split-alternate:active) {
    background: color-mix(in srgb, var(--fg) 82%, var(--bg));
    transform: none;
  }

  @media (hover: hover) and (pointer: fine) {
    .split-menu :global(.den-button.split-alternate:hover) {
      border-color: transparent;
      background: color-mix(in srgb, var(--fg) 88%, var(--bg));
    }
  }

  @keyframes reveal-destination {
    from {
      opacity: 0;
    }

    to {
      opacity: 1;
    }
  }

  @media (width >= 760px) {
    .split-button {
      width: auto;
    }

    .split-surface :global(.den-button.split-toggle) {
      flex-basis: 44px;
      width: 44px;
    }

    .split-menu :global(.den-button.split-alternate) {
      min-height: 44px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .split-surface {
      transition: none;
    }

    .split-surface :global(.split-toggle svg[data-icon='chevron']) {
      transition: none;
    }

    .split-menu {
      animation: none;
    }
  }
</style>
