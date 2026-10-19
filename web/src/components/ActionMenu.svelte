<!-- The one menu button (the W3C menu-button pattern) behind every "what can I do to this title" control: a
     poster's ⋯ (den-edge#236) and the episode row's options (den-edge#237, replacing its old `<details>`).

     A native `popover="auto"` element does the open/close state, light dismiss, Escape and "only one open at a
     time" for free; this adds the W3C menu's keyboard model (arrows, Home/End, type-ahead), the one-item-runs-
     then-closes-and-returns-focus behaviour, and a bottom sheet below 760px or on a coarse pointer. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onDestroy, tick } from 'svelte';
  import Button from './Button.svelte';
  import type { MenuItem } from '../lib/titleActions';

  let {
    items,
    label,
    heading,
    note,
    glyph,
    triggerClass = '',
    onclose,
  }: {
    /** Called once the menu has closed and focus has gone back to the trigger. */
    onclose?: () => void;
    /** Built only while this menu is open. An array keeps episode menus source-compatible. */
    items: MenuItem[] | (() => MenuItem[]);
    /** The trigger's accessible name ("Actions for Dune", "Options for episode 3"). */
    label: string;
    /** Headed with this on the phone bottom sheet; omitted there is no heading. */
    heading?: string;
    /** A line above the items, on the popover and the sheet alike, saying where things stand: read, not pressed. */
    note?: string;
    /** The trigger's visible content. */
    glyph: Snippet;
    /** Extra classes on the trigger, so a poster's corner button and an episode's circle can differ. */
    triggerClass?: string;
  } = $props();

  const menuId = $props.id();
  let trigger: HTMLButtonElement;
  let menu = $state<HTMLDivElement | HTMLDialogElement>();
  let prepared = $state(false);
  let open = $state(false);
  let mobile = $state(false);
  const shownItems = $derived.by(() => {
    if (!prepared) return [];
    return typeof items === 'function' ? items() : items;
  });
  /** Where a right-click or long-press opened this, in viewport coordinates; null for the trigger's own click. */
  let coords: { x: number; y: number } | null = null;
  /** Set just before a Tab closes the menu, so the toggle handler doesn't steal the focus Tab is moving to. */
  let suppressRefocus = false;
  /** A finger down on the sheet's list while it is at its top, dragged past `SHEET_DRAG_CLOSE_PX`, dismisses it —
   * the bottom-sheet "drag down to close" convention (`ContentWarnings` does the same). Keyed by pointerId so a
   * second touch can't finish a drag it didn't start. */
  let sheetDragStart: { y: number; pointerId: number } | null = null;
  const SHEET_DRAG_CLOSE_PX = 24;
  /** The sheet's scrolling list, below its head. */
  let list = $state<HTMLDivElement>();
  /**
   * A finger on the sheet's head (its handle, heading and note): the sheet follows it down, and on release closes
   * past `HEAD_CLOSE_FRACTION` of its height or on a downward flick faster than `HEAD_FLICK_PX_PER_MS`, else
   * springs back. Barely moved, it is a tap, which closes it. `recent` is the last `HEAD_FLICK_WINDOW_MS` of
   * positions, which the release's speed is measured over.
   */
  let headDrag: {
    pointerId: number;
    y: number;
    moved: number;
    recent: { y: number; t: number }[];
  } | null = null;
  /** Set by a head pointerup that barely moved, for the `click` that follows it. */
  let headTapped = false;
  const HEAD_CLOSE_FRACTION = 0.3;
  const HEAD_FLICK_PX_PER_MS = 0.5;
  const HEAD_FLICK_WINDOW_MS = 100;
  const HEAD_TAP_SLOP_PX = 8;
  const SHEET_SETTLE_MS = 220;
  /**
   * Set by `outsidePointerDown` for the one `click` its own gesture is about to produce — decided fresh on
   * every `pointerdown`, so it never outlives the gesture that set it (a drag with no following click, a
   * later unrelated tap) stale-true.
   */
  let swallowNextClick = false;
  // Native light-dismiss may close the popover between a trigger pointerdown and its click. Remember what
  // that gesture started on so the click remains a true close instead of seeing "closed" and reopening it.
  let triggerWasOpenOnPointerDown = false;
  let focusFrame: number | undefined;

  function cancelFocusFrame() {
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
    focusFrame = undefined;
  }

  onDestroy(cancelFocusFrame);

  // A closed poster contributes a trigger, not a matchMedia subscription and five global listeners. Native auto
  // popovers ensure only one menu is open, so listener work stays constant however many posters a long row retains.
  $effect(() => {
    if (!prepared) return;
    const query =
      typeof matchMedia === 'undefined'
        ? undefined
        : matchMedia('(max-width: 759px), (pointer: coarse)');
    const update = () => (mobile = query!.matches);
    if (query) mobile = query.matches;
    query?.addEventListener('change', update);
    // A `pointerdown` outside both the menu and its trigger closes the menu — the native popover does that too,
    // but only sometimes stops there (see `outsideClick`) — and a `click` is swallowed only when the same
    // pointer gesture asked for it. Pointerdown never prevents a default, so it is passive; click cannot be.
    document.addEventListener('pointerdown', outsidePointerDown, {
      capture: true,
      passive: true,
    });
    document.addEventListener('click', outsideClick, { capture: true });
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

  async function show(at: { x: number; y: number } | null) {
    coords = at;
    if (!prepared) {
      prepared = true;
      await tick();
    }
    if (!menu) return;
    // Position while it is still hidden. Waiting until `beforetoggle` and then a frame lets the browser paint
    // the newly top-layer popover once at its unanchored fallback before the requested coordinates arrive.
    position();
    if (__DEN_TV__) {
      const dialog = menu as HTMLDialogElement;
      if (!dialog.open) {
        dialog.showModal();
        opened();
      }
    } else if (!menu.matches(':popover-open')) {
      menu.showPopover();
      // Measured now that it is laid out, and placed again before it is painted.
      position();
    }
  }

  function showing() {
    return __DEN_TV__
      ? (menu as HTMLDialogElement | undefined)?.open === true
      : (menu?.matches(':popover-open') ?? false);
  }

  function toggleFromTrigger(event: MouseEvent) {
    const closesPointerGesture = event.detail > 0 && triggerWasOpenOnPointerDown;
    triggerWasOpenOnPointerDown = false;
    if (closesPointerGesture || showing()) {
      close();
      open = false;
      trigger?.focus();
    } else void show(null);
  }

  /** Open anchored to a point rather than the trigger — a right-click or a long-press on the card. */
  export function openAt(x: number, y: number) {
    void show({ x, y });
  }

  export function focus() {
    trigger?.focus();
  }

  export function close() {
    if (__DEN_TV__) {
      const dialog = menu as HTMLDialogElement | undefined;
      if (dialog?.open) dialog.close();
    } else menu?.hidePopover();
  }

  function finishClose() {
    // Removing a popover need not preserve its queued `toggle` event. Keep the trigger truthful synchronously even
    // when an outside gesture releases the body before that event is delivered.
    open = false;
    cancelFocusFrame();
    prepared = false;
  }

  function menuItemEls(): HTMLButtonElement[] {
    return Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? []);
  }

  function enabledItemEls(): HTMLButtonElement[] {
    return menuItemEls().filter((el) => el.getAttribute('aria-disabled') !== 'true');
  }

  /** Measured and written while the popover is hidden, before `showPopover` puts it in the top layer. */
  function position() {
    const positioned = menu;
    if (!positioned) return;
    if (mobile) {
      positioned.style.removeProperty('left');
      positioned.style.removeProperty('top');
      return;
    }
    const vw = window.innerWidth,
      vh = window.innerHeight;
    // Before its first showing it is not laid out, so a representative size stands in for the real one — close
    // enough to decide which side of the viewport it has to flip away from. Once shown, its own size is used:
    // items with a second line are taller than the estimate.
    const width = positioned.offsetWidth || 240,
      height = positioned.offsetHeight || shownItems.length * 44 + 16;
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
    positioned.style.left = `${x}px`;
    positioned.style.top = `${y}px`;
  }

  function opened() {
    open = true;
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
    focusFrame = requestAnimationFrame(() => {
      focusFrame = undefined;
      const enabled = enabledItemEls();
      // `showModal()` and its open event do not focus consistently across TV engines. Supply the missing initial
      // focus on the next frame, but never steal back a later choice when a fast remote press has already moved
      // within the menu during that frame.
      if (!enabled.includes(document.activeElement as HTMLButtonElement)) enabled[0]?.focus();
    });
  }

  function closed() {
    open = false;
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
    focusFrame = undefined;
    sheetDragStart = null;
    headDrag = null;
    menu?.style.removeProperty('transform');
    menu?.style.removeProperty('transition');
    coords = null;
    if (!suppressRefocus) trigger?.focus();
    suppressRefocus = false;
    onclose?.();
    // An outside pointerdown must retain the capture-click listener through the click that follows it. That click
    // calls `finishClose`; every other close can release the menu body and listeners immediately.
    if (!swallowNextClick) finishClose();
  }

  function toggled(event: ToggleEvent) {
    if (event.newState === 'open') opened();
    else closed();
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
    if (!showing()) {
      // A drag can end without a click. A later pointerdown starts a different gesture and must not let that stale
      // swallow escape into its click; releasing `prepared` also tears down the listeners left for the old gesture.
      if (swallowNextClick) {
        swallowNextClick = false;
        finishClose();
      }
      return;
    }
    const target = event.target;
    const inside = target instanceof Node && (menu?.contains(target) || trigger?.contains(target));
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
    finishClose();
  }

  /** The keys that page-scroll an element with no handler of its own — Home/End and the arrows are excluded:
   * inside the menu they navigate it instead (`onMenuKeydown`), and outside it they are as likely to be
   * moving a caret or another widget's selection as scrolling the page. */
  const SCROLL_KEYS = new Set([' ', 'PageUp', 'PageDown']);

  /** A wheel, a touch drag, or a keyboard page-scroll key, landing outside the menu and its own trigger. */
  function outsideScrollGesture(event: WheelEvent | TouchEvent | KeyboardEvent) {
    if (!showing()) return;
    if (event instanceof KeyboardEvent && !SCROLL_KEYS.has(event.key)) return;
    const target = event.target;
    if (target instanceof Node && (menu?.contains(target) || trigger?.contains(target))) return;
    close();
  }

  function sheetPointerDown(event: PointerEvent) {
    // A list scrolled down is scrolled back up by the same drag: only one at its top closes.
    if (!mobile || event.pointerType === 'mouse' || (list?.scrollTop ?? 0) > 0) return;
    sheetDragStart = { y: event.clientY, pointerId: event.pointerId };
  }

  function headPointerDown(event: PointerEvent) {
    if (!menu) return;
    headTapped = false;
    headDrag = {
      pointerId: event.pointerId,
      y: event.clientY,
      moved: 0,
      recent: [{ y: event.clientY, t: event.timeStamp }],
    };
    // A synthetic or already-released pointer can't be captured; the moves still arrive over the head.
    try {
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
    } catch {
      // nothing to capture
    }
    menu.style.transition = 'none';
  }

  function headPointerMove(event: PointerEvent) {
    if (!headDrag || event.pointerId !== headDrag.pointerId || !menu) return;
    const dy = event.clientY - headDrag.y;
    headDrag.moved = Math.max(headDrag.moved, Math.abs(dy));
    headDrag.recent = [
      ...headDrag.recent.filter((one) => event.timeStamp - one.t <= HEAD_FLICK_WINDOW_MS),
      { y: event.clientY, t: event.timeStamp },
    ];
    // Down only: above its resting place the sheet would leave the bottom edge.
    menu.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
  }

  function headPointerUp(event: PointerEvent) {
    const drag = headDrag;
    if (!drag || event.pointerId !== drag.pointerId || !menu) return;
    headDrag = null;
    const dy = event.clientY - drag.y;
    // A tap: its own `click` closes the sheet (`headClick`). Closing here would leave that click to land on whatever
    // the sheet covered.
    if (drag.moved < HEAD_TAP_SLOP_PX) {
      headTapped = true;
      menu.style.transform = '';
      return;
    }
    const recent = [
      ...drag.recent.filter((one) => event.timeStamp - one.t <= HEAD_FLICK_WINDOW_MS),
      { y: event.clientY, t: event.timeStamp },
    ];
    const first = recent[0]!;
    const speed = (event.clientY - first.y) / Math.max(1, event.timeStamp - first.t);
    settle(
      dy > 0 && (dy > menu.offsetHeight * HEAD_CLOSE_FRACTION || speed > HEAD_FLICK_PX_PER_MS),
    );
  }

  /** The click of a tap on the head, never of a drag that ended there. */
  function headClick() {
    if (!headTapped) return;
    headTapped = false;
    close();
  }

  function headPointerCancel(event: PointerEvent) {
    if (headDrag?.pointerId !== event.pointerId) return;
    headDrag = null;
    settle(false);
  }

  /** The sheet let go of: off the bottom and closed, or back where it rests. No travel with reduced motion. */
  function settle(dismiss: boolean) {
    const sheet = menu;
    if (!sheet) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (dismiss && still) close();
    else if (dismiss) {
      sheet.style.transition = `transform ${SHEET_SETTLE_MS}ms ease-in`;
      sheet.style.transform = 'translateY(100%)';
      setTimeout(() => {
        if (menu === sheet) close();
      }, SHEET_SETTLE_MS);
    } else {
      // A spring: back a little past where it rests, then home.
      sheet.style.transition = still
        ? 'none'
        : `transform ${SHEET_SETTLE_MS}ms cubic-bezier(0.3, 1.4, 0.5, 1)`;
      sheet.style.transform = '';
    }
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
    // A link item's page is the Router's to open on a plain click, and the browser's on any other: only the menu goes.
    if (item.kind !== 'link') item.onselect();
    close();
  }

  function onMenuKeydown(event: KeyboardEvent) {
    const nav = enabledItemEls();
    const at = nav.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      // Closes the menu and nothing else: the key must not also reach a container with its own Escape (a settings
      // row collapsing around the menu's trigger).
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown') {
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
  aria-controls={prepared ? menuId : undefined}
  aria-label={label}
  onpointerdown={() => (triggerWasOpenOnPointerDown = showing())}
  onclick={toggleFromTrigger}
>
  {@render glyph()}
</button>

{#if prepared}
  {#snippet contents()}
    {#if mobile}
      <!-- The sheet's head: dragged, the sheet follows the finger; tapped, it closes. -->
      <div
        class="sheet-head"
        role="presentation"
        onpointerdown={headPointerDown}
        onpointermove={headPointerMove}
        onpointerup={headPointerUp}
        onpointercancel={headPointerCancel}
        onclick={headClick}
      >
        <span class="sheet-handle" aria-hidden="true"></span>
        {#if heading}<p class="sheet-heading">{heading}</p>{/if}
        {#if note}<p class="menu-note" id={`${menuId}-note`}>{note}</p>{/if}
      </div>
    {:else if note}<p class="menu-note" id={`${menuId}-note`}>{note}</p>{/if}
    <!-- Only a wrapper, so the menu still owns its items; on the sheet, what scrolls under the head. -->
    <div class="items" role="presentation" bind:this={list} onpointerdown={sheetPointerDown}>
      {#each shownItems as item, i (`${item.kind}:${item.label}:${i}`)}
        <Button
          variant="menu"
          size="regular"
          label={item.label}
          href={item.kind === 'link' ? item.href : undefined}
          role={item.kind === 'item' || item.kind === 'link'
            ? 'menuitem'
            : item.kind === 'checkbox'
              ? 'menuitemcheckbox'
              : 'menuitemradio'}
          aria-checked={item.kind === 'item' || item.kind === 'link' ? undefined : item.checked}
          aria-disabled={item.disabled || undefined}
          aria-describedby={item.description ? `${menuId}-${i}` : undefined}
          class={item.description ? 'item described' : 'item'}
          onclick={() => run(item)}
        >
          {#if item.description}<span class="item-description" id={`${menuId}-${i}`}
              >{item.description}</span
            >{/if}
        </Button>
      {/each}
    </div>
  {/snippet}
  {#if __DEN_TV__}
    <dialog
      bind:this={menu}
      id={menuId}
      class="menu"
      class:sheet={mobile}
      role="menu"
      aria-label={label}
      aria-describedby={note ? `${menuId}-note` : undefined}
      tabindex="-1"
      onclose={closed}
      onkeydown={onMenuKeydown}
      onpointermove={sheetPointerMove}
      onpointerup={sheetPointerUp}
      onpointercancel={sheetPointerUp}
    >
      {@render contents()}
    </dialog>
  {:else}
    <div
      bind:this={menu}
      id={menuId}
      class="menu"
      class:sheet={mobile}
      popover="auto"
      role="menu"
      aria-label={label}
      aria-describedby={note ? `${menuId}-note` : undefined}
      tabindex="-1"
      ontoggle={toggled}
      onkeydown={onMenuKeydown}
      onpointermove={sheetPointerMove}
      onpointerup={sheetPointerUp}
      onpointercancel={sheetPointerUp}
    >
      {@render contents()}
    </div>
  {/if}
{/if}

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

  .trigger[aria-expanded='true'] {
    visibility: visible;
    opacity: 1;
    pointer-events: auto;
  }

  .menu {
    position: fixed;
    inset: auto;
    z-index: 50;
    width: max-content;
    min-width: 220px;
    max-width: min(320px, 90vw);
    max-height: calc(100dvh - 16px);
    overflow-y: auto;
    margin: 0;
    padding: 6px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: #222228;
    box-shadow: 0 12px 40px #0008;
  }

  .menu :global(.item) {
    border-radius: 8px;
    padding: 8px 12px;
    text-align: left;
  }

  .menu :global(.item:hover),
  .menu :global(.item:focus-visible) {
    background: #fff2;
  }

  .menu :global(.item:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .menu :global(.item[aria-checked='true']) {
    font-weight: 600;
  }

  .menu :global(.item[aria-disabled='true']) {
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
    padding: 0 8px max(8px, env(safe-area-inset-bottom));

    /* The head stays put while the list under it scrolls. */
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .sheet .items {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  /* The grab area: a finger here moves the sheet, never the page or the list. */
  .sheet-head {
    flex: none;
    padding-top: 8px;
    touch-action: none;
    cursor: grab;
  }

  .sheet-handle {
    display: block;
    width: 36px;
    height: 4px;
    margin: 0 auto 4px;
    border-radius: 2px;
    background: var(--muted);
    opacity: 0.6;
  }

  .sheet-heading {
    margin: 6px 10px 8px;
    color: var(--muted);
    font-size: 13px;
    font-weight: 600;
  }

  /* An item with a second line: the label over it, both wrapping rather than running off the menu's edge. */
  .menu :global(.item.described) {
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
    padding-block: 10px;
    line-height: 1.3;
    white-space: normal;
  }

  /* A choice among described items carries a tick column, so the one chosen is marked by more than weight and
     the labels line up whichever it is. */
  .menu :global(.item.described[role='menuitemradio']) {
    position: relative;
    padding-left: 36px;
  }

  .menu :global(.item.described[role='menuitemradio'][aria-checked='true'])::before {
    position: absolute;
    top: 10px;
    left: 12px;
    content: '✓';
    color: var(--accent);
    font-weight: 700;
  }

  .item-description {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    color: var(--muted);
    font-size: 12px;
    font-weight: 400;
    overflow-wrap: anywhere;
  }

  /* Plain text in the item's own inset: it says where things stand, so nothing about it looks pressable. */
  .menu-note {
    margin: 0;
    padding: 8px 12px 6px;
    font-size: 14px;
    line-height: 1.35;
  }

  .sheet :global(.item) {
    min-height: 48px;
  }
</style>
