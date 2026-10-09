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

  async function show() {
    if (busy) return;
    open = true;
    await tick();
    alternate?.focus();
  }

  function hide(returnFocus = false) {
    open = false;
    if (returnFocus) trigger?.focus();
  }

  function toggle() {
    if (open) hide(true);
    else void show();
  }

  function chooseAlternate() {
    open = false;
    onalternate();
  }

  function leave(event: FocusEvent) {
    if (open && !root?.contains(event.relatedTarget as Node | null)) open = false;
  }

  $effect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root?.contains(event.target as Node)) open = false;
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

<div class="split-button" bind:this={root} onfocusout={leave}>
  <Button variant="primary" size="large" class="split-main" {icon} {label} {busy} {onclick} />
  <Button
    bind:element={trigger}
    variant="primary"
    size="large"
    class="split-toggle"
    icon="chevron"
    ariaLabel={`More ways to ${label.toLowerCase()}`}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls={menuId}
    {busy}
    onclick={toggle}
    onkeydown={(event) => {
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      void show();
    }}
  />
  {#if open}
    <div class="split-menu" id={menuId} role="menu">
      <Button
        bind:element={alternate}
        variant="menu"
        class="split-alternate"
        icon={alternateIcon}
        label={alternateLabel}
        role="menuitem"
        onclick={chooseAlternate}
      />
    </div>
  {/if}
</div>

<style>
  .split-button {
    position: relative;
    display: flex;
    width: 100%;
    min-width: 0;
  }

  :global(.split-main) {
    flex: 1 1 auto;
    border-radius: 12px 0 0 12px;
  }

  :global(.split-toggle) {
    --button-icon-size: 16px;

    flex: 0 0 48px;
    width: 48px;
    padding: 0;
    border-left-color: color-mix(in srgb, var(--bg) 24%, transparent);
    border-radius: 0 12px 12px 0;
  }

  .split-menu {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: 8;
    width: max-content;
    min-width: 180px;
    padding: 6px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: color-mix(in srgb, var(--card) 96%, black);
    box-shadow: 0 14px 40px rgb(0 0 0 / 0.45);
  }

  :global(.split-alternate) {
    min-height: 44px;
  }

  @media (width >= 760px) {
    .split-button {
      width: auto;
    }
  }
</style>
