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
  /** A finger down on the sheet, dragged past `SHEET_DRAG_CLOSE_PX`, dismisses it — the bottom-sheet "drag
   * down to close" convention (`ContentWarnings` does the same). Keyed by pointerId so a second touch
   * can't finish a drag it didn't start. */
  let sheetDragStart: { y: number; pointerId: number } | null = null;
  const SHEET_DRAG_CLOSE_PX = 24;
  /**
   * Set by `outsidePointerDown` for the one `click` its own gesture is about to produce — decided fresh on
   * every `pointerdown`, so it never outlives the gesture that set it (a drag with no following click, a
   * later unrelated tap) stale-true.
   */
  let swallowNextClick = false;

  onMount(() => {
    const query =
      typeof matchMedia === 'undefined'
        ? undefined
        : matchMedia('(max-width: 759px), (pointer: coarse)');
    const update = () => (mobile = query!.matches);
    query?.addEventListener('change', update);
    // Permanent, not tied to `open`: a `pointerdown` outside both the menu and its trigger closes the menu —
    // the native popover does that too, but only sometimes stops there (see `outsideClick`) — and a `click`
    // is swallowed only when the `pointerdown` that preceded it asked for it.
    document.addEventListener('pointerdown', outsidePointerDown, true);
    document.addEventListener('click', outsideClick, true);
    // The user's own scroll gestures landing outside the menu — a wheel, a touch drag, a keyboard page-scroll
    // key — close it, the same as a tap outside would (den-edge#260). Not the `scroll` event itself: that
    // fires for the *result* of scrolling as much as the cause, and the W3C menu's own arrow-key model moves
    // focus to items a short popover never has room for, which the browser then scrolls into view by itself
    // (so does `scrollIntoView`, so does a smooth-scroll settling) — none of that is the page moving behind
    // the menu, so closing on it would drop a keyboard or screen-reader user out of their own menu mid-press.
    window.addEventListener('wheel', outsideScrollGesture, { capture: true, passive: true });
    window.addEventListener('touchmove', outsideScrollGesture, { capture: true, passive: true });
    window.addEventListener('keydown', outsideScrollGesture, true);
    return () => {
      query?.removeEventListener('change', update);
      document.removeEventListener('pointerdown', outsidePointerDown, true);
      document.removeEventListener('click', outsideClick, true);
      window.removeEventListener('wheel', outsideScrollGesture, true);
      window.removeEventListener('touchmove', outsideScrollGesture, true);
      window.removeEventListener('keydown', outsideScrollGesture, true);
    };
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

  /**
   * Measured before the popover is actually shown (`beforetoggle`), so it never flashes into the wrong place.
   *
   * The write is deferred one frame (`requestAnimationFrame`), still ahead of the next paint: writing
   * `menu.style` synchronously inside `beforetoggle` — after any prior pointer move had already queued a style
   * recalc of its own (a hover, even an unrelated one) — silently drops the browser's own `toggle` event, which
   * is what actually flips `open`/`aria-expanded`. The read stays synchronous; only the write moves.
   */
  function position() {
    if (!menu) return;
    if (mobile) {
      requestAnimationFrame(() => {
        menu.style.removeProperty('left');
        menu.style.removeProperty('top');
      });
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
    requestAnimationFrame(() => {
      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;
    });
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
      sheetDragStart = null;
      coords = null;
      if (!suppressRefocus) trigger?.focus();
      suppressRefocus = false;
    }
  }

  /**
   * A `pointerdown` outside the menu and outside its own trigger — exactly what the browser's own popover
   * light-dismiss treats as "outside" too. Closing it here, deterministically, rather than leaving it to
   * that native behaviour: the native close can land before the `click` this same gesture is about to fire
   * (its timing isn't ours to rely on), and by then whatever is under the pointer would already be exposed
   * to it — which is the tap-through bug this fixes. `swallowNextClick` is decided fresh here on every
   * `pointerdown`, independent of that timing, so `outsideClick` always knows what to do with the `click`
   * that follows, whichever element it lands on.
   *
   * Checks `:popover-open` rather than the reactive `open` — the `toggle` event that sets `open` can itself
   * land late (see `position`'s own comment on a queued style recalc dropping it), so a pointerdown landing
   * in that gap would see a stale `open === false` for a menu the browser already shows, and wave it through.
   * `:popover-open` is the browser's own synchronous answer to "is this showing right now", independent of
   * whether that event has fired yet.
   */
  function outsidePointerDown(event: PointerEvent) {
    if (!menu?.matches(':popover-open')) return;
    const target = event.target;
    const inside = target instanceof Node && (menu.contains(target) || trigger?.contains(target));
    swallowNextClick = !inside;
    if (swallowNextClick) close();
  }

  /** The `click` a swallowed `pointerdown` is about to produce — stopped before it can run whatever it
   * landed on (a poster's own `<a>`, another trigger), in capture so it never even reaches that element. */
  function outsideClick(event: MouseEvent) {
    if (!swallowNextClick) return;
    swallowNextClick = false;
    event.preventDefault();
    event.stopPropagation();
  }

  /** The keys that page-scroll an element with no handler of its own — Home/End and the arrows are excluded:
   * inside the menu they navigate it instead (`onMenuKeydown`), and outside it they are as likely to be
   * moving a caret or another widget's selection as scrolling the page. */
  const SCROLL_KEYS = new Set([' ', 'PageUp', 'PageDown']);

  /** A wheel, a touch drag, or a keyboard page-scroll key, landing outside the menu and its own trigger. */
  function outsideScrollGesture(event: WheelEvent | TouchEvent | KeyboardEvent) {
    if (!menu?.matches(':popover-open')) return;
    if (event instanceof KeyboardEvent && !SCROLL_KEYS.has(event.key)) return;
    const target = event.target;
    if (target instanceof Node && (menu.contains(target) || trigger?.contains(target))) return;
    close();
  }

  function sheetPointerDown(event: PointerEvent) {
    if (!mobile || event.pointerType === 'mouse') return;
    sheetDragStart = { y: event.clientY, pointerId: event.pointerId };
  }
  function sheetPointerMove(event: PointerEvent) {
    if (!sheetDragStart || event.pointerId !== sheetDragStart.pointerId) return;
    if (event.clientY - sheetDragStart.y > SHEET_DRAG_CLOSE_PX) {
      sheetDragStart = null;
      close();
    }
  }
  function sheetPointerUp(event: PointerEvent) {
    if (sheetDragStart?.pointerId === event.pointerId) sheetDragStart = null;
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
  onpointerdown={sheetPointerDown}
  onpointermove={sheetPointerMove}
  onpointerup={sheetPointerUp}
  onpointercancel={sheetPointerUp}
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
