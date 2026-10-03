<!-- The one menu button (the W3C menu-button pattern) behind every "what can I do to this title" control: a
     poster's ⋯ (den-edge#236) and the episode row's options (den-edge#237, replacing its old `<details>`).

     A native `popover="auto"` element does the open/close state, light dismiss, Escape and "only one open at a
     time" for free; this adds the W3C menu's keyboard model (arrows, Home/End, type-ahead), the one-item-runs-
     then-closes-and-returns-focus behaviour, and a bottom sheet below 760px or on a coarse pointer. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import type { MenuItem } from '../lib/titleActions';

  let {
    items,
    label,
    heading,
    glyph,
    triggerClass = '',
  }: {
    items: MenuItem[];
    /** The trigger's accessible name ("Actions for Dune", "Options for episode 3"). */
    label: string;
    /** Headed with this on the phone bottom sheet; omitted there is no heading. */
    heading?: string;
    /** The trigger's visible content. */
    glyph: Snippet;
    /** Extra classes on the trigger, so a poster's corner button and an episode's circle can differ. */
    triggerClass?: string;
  } = $props();

  const menuId = $props.id();
  let trigger: HTMLButtonElement;
  let menu: HTMLDivElement;
  let open = $state(false);
  let mobile = $state(
    typeof matchMedia === 'undefined'
      ? false
      : matchMedia('(max-width: 759px), (pointer: coarse)').matches,
  );
  /** Where a right-click or long-press opened this, in viewport coordinates; null for the trigger's own click. */
  let coords: { x: number; y: number } | null = null;
  /** Set just before a Tab closes the menu, so the toggle handler doesn't steal the focus Tab is moving to. */
  let suppressRefocus = false;

  onMount(() => {
    if (typeof matchMedia === 'undefined') return;
    const query = matchMedia('(max-width: 759px), (pointer: coarse)');
    const update = () => (mobile = query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  });

  /** Open anchored to a point rather than the trigger — a right-click or a long-press on the card. */
  export function openAt(x: number, y: number) {
    coords = { x, y };
    menu?.showPopover();
  }

  export function close() {
    menu?.hidePopover();
  }

  function menuItemEls(): HTMLButtonElement[] {
    return Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? []);
  }

  function enabledItemEls(): HTMLButtonElement[] {
    return menuItemEls().filter((el) => el.getAttribute('aria-disabled') !== 'true');
  }

  /** Measured before the popover is actually shown (`beforetoggle`), so it never flashes into the wrong place. */
  function position() {
    if (!menu) return;
    if (mobile) {
      menu.style.removeProperty('left');
      menu.style.removeProperty('top');
      return;
    }
    const vw = window.innerWidth,
      vh = window.innerHeight;
    // Not yet laid out at this point, so a representative size stands in for the real one — close enough to
    // decide which side of the viewport it has to flip away from.
    const width = 240,
      height = items.length * 44 + 16;
    let x: number, y: number;
    if (coords) {
      x = coords.x;
      y = coords.y;
    } else {
      const rect = trigger.getBoundingClientRect();
      x = rect.right - width;
      y = rect.bottom + 6;
      if (y + height > vh) y = rect.top - height - 6;
    }
    x = Math.min(Math.max(8, x), Math.max(8, vw - width - 8));
    y = Math.min(Math.max(8, y), Math.max(8, vh - height - 8));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }

  function beforeToggle(event: ToggleEvent) {
    if (event.newState === 'open') position();
  }

  function toggled(event: ToggleEvent) {
    open = event.newState === 'open';
    if (open) {
      // The popover is in the top layer by the time `toggle` fires, so the first item can take focus now.
      requestAnimationFrame(() => enabledItemEls()[0]?.focus());
    } else {
      coords = null;
      if (!suppressRefocus) trigger?.focus();
      suppressRefocus = false;
    }
  }

  function run(item: MenuItem) {
    if (item.disabled) return;
    item.onselect();
    close();
  }

  function onMenuKeydown(event: KeyboardEvent) {
    const nav = enabledItemEls();
    const at = nav.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      nav[(at + 1 + nav.length) % nav.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      nav[(at - 1 + nav.length) % nav.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      nav[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      nav[nav.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      // Closed, not trapped: Tab moves on to whatever is next on the page, as it would with no menu open.
      suppressRefocus = true;
      close();
    } else if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const letter = event.key.toLowerCase();
      const start = (at + 1 + nav.length) % nav.length;
      for (let step = 0; step < nav.length; step++) {
        const el = nav[(start + step) % nav.length];
        if (el?.textContent?.trim().toLowerCase().startsWith(letter)) {
          event.preventDefault();
          el.focus();
          break;
        }
      }
    }
  }
</script>

<button
  bind:this={trigger}
  type="button"
  class="trigger {triggerClass}"
  aria-haspopup="menu"
  aria-expanded={open}
  aria-controls={menuId}
  aria-label={label}
  popovertarget={menuId}
  onclick={() => (coords = null)}
>
  {@render glyph()}
</button>

<div
  bind:this={menu}
  id={menuId}
  class="menu"
  class:sheet={mobile}
  popover="auto"
  role="menu"
  aria-label={label}
  tabindex="-1"
  onbeforetoggle={beforeToggle}
  ontoggle={toggled}
  onkeydown={onMenuKeydown}
>
  {#if mobile && heading}<p class="sheet-heading">{heading}</p>{/if}
  {#each items as item, i (`${item.kind}:${item.label}:${i}`)}
    <button
      type="button"
      role={item.kind === 'item'
        ? 'menuitem'
        : item.kind === 'checkbox'
          ? 'menuitemcheckbox'
          : 'menuitemradio'}
      aria-checked={item.kind === 'item' ? undefined : item.checked}
      aria-disabled={item.disabled || undefined}
      class="item"
      onclick={() => run(item)}
    >
      {item.label}
    </button>
  {/each}
</div>

<style>
  .trigger {
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .menu {
    position: fixed;
    inset: auto;
    z-index: 50;
    width: max-content;
    min-width: 220px;
    max-width: min(320px, 90vw);
    margin: 0;
    padding: 6px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: #222228;
    box-shadow: 0 12px 40px #0008;
  }

  .item {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 44px;
    border: 0;
    border-radius: 8px;
    padding: 8px 12px;
    background: none;
    color: var(--fg);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .item:hover,
  .item:focus-visible {
    background: #fff2;
  }

  .item:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .item[aria-checked='true'] {
    font-weight: 600;
  }

  .item[aria-disabled='true'] {
    color: var(--muted);
    cursor: default;
  }

  /* Below 760px, or on a coarse pointer: a sheet from the bottom, headed with the title, rather than a popover
     anchored to a corner button a finger has just covered. */
  .menu.sheet {
    position: fixed;
    inset: auto 0 0;
    left: 0;
    top: auto;
    width: 100%;
    max-width: none;
    border-radius: 16px 16px 0 0;
    padding: 8px 8px max(8px, env(safe-area-inset-bottom));
  }

  .sheet-heading {
    margin: 6px 10px 8px;
    color: var(--muted);
    font-size: 13px;
    font-weight: 600;
  }

  .sheet .item {
    min-height: 48px;
  }
</style>
