export interface TvRemoteActions {
  close(): void;
  next?(): void;
  pause(): void;
  play(): void | Promise<void>;
  seekBy(seconds: number): void;
  paused(): boolean;
  adjustSubtitleTiming?(seconds: number): boolean;
  closeSubtitleTiming?(): boolean;
  showDetails?(): void;
  closeDetails?(): boolean;
}

const PLAY_KEYS = new Set(['MediaPlay', 'MediaPlayPause', 'Play']);
const PAUSE_KEYS = new Set(['MediaPause', 'Pause']);
const REVEAL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Enter', 'Select']);
const HIDE_MS = 4_000;

/**
 * Translate keys exposed by webOS, Tizen and desktop TV previews into the same
 * transport actions. Direction keys remain navigation keys while a form control
 * is focused; over the picture they seek without requiring a pointer.
 */
export function installTvRemote(actions: TvRemoteActions): () => void {
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let hidden = false;
  let editing: HTMLSelectElement | undefined;
  let detailsOrigin: HTMLElement | undefined;
  const root = document.querySelector<HTMLElement>('.player');
  const openMenu = () => root?.querySelector<HTMLDialogElement>('dialog[role="menu"][open]');
  const closeOpenMenu = (): boolean => {
    const menu = openMenu();
    if (!menu) return false;
    const cancel = new Event('cancel', { cancelable: true });
    if (menu.dispatchEvent(cancel)) menu.close();
    return true;
  };
  const closeDetails = (): boolean => {
    if (!actions.closeDetails?.()) return false;
    const origin = detailsOrigin;
    detailsOrigin = undefined;
    queueMicrotask(() => origin?.focus({ preventScroll: true }));
    return true;
  };
  const regions = () =>
    root ? [...root.querySelectorAll<HTMLElement>('header, footer, .tv-transport')] : [];
  const setHidden = (next: boolean) => {
    hidden = next;
    root?.classList.toggle('tv-controls-hidden', next);
    for (const region of regions()) {
      region.inert = next;
      if (next) region.setAttribute('aria-hidden', 'true');
      else region.removeAttribute('aria-hidden');
    }
    if (next && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };
  const scheduleHide = () => {
    clearTimeout(hideTimer);
    if (!actions.paused() && !openMenu())
      hideTimer = setTimeout(() => {
        // A menu may have opened since this idle period began. It lives inside the footer, so hiding/inerting the
        // footer would also blur and disable the menu while the viewer is still choosing from it.
        if (!openMenu()) setHidden(true);
      }, HIDE_MS);
  };
  const reveal = () => {
    setHidden(false);
    scheduleHide();
  };
  const revealPaused = () => {
    // Some TV engines dispatch `pause` before their `paused` getter reflects it. Never let that transient value
    // schedule a new idle hide over controls the viewer deliberately paused to use.
    clearTimeout(hideTimer);
    setHidden(false);
  };

  const onKey = (event: KeyboardEvent) => {
    // Global TV navigation turns a Back key outside focused player controls into `den:tv-back`.
    // Its canceled dispatch already called `close`; do not handle that same original key a second time.
    if (event.defaultPrevented) return;
    const timingStep = event.key === 'ArrowLeft' ? -0.5 : event.key === 'ArrowRight' ? 0.5 : 0;
    if (timingStep && actions.adjustSubtitleTiming?.(timingStep)) {
      reveal();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (
      (event.key === 'Enter' ||
        event.key === 'Select' ||
        event.key === 'Escape' ||
        event.key === 'Back' ||
        event.key === 'BrowserBack' ||
        event.key === 'ArrowUp' ||
        event.key === 'ArrowDown') &&
      actions.closeSubtitleTiming?.()
    ) {
      reveal();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = event.target;
    const interactive =
      target instanceof HTMLSelectElement ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLButtonElement ||
      target instanceof HTMLAnchorElement;
    if (target !== editing && event.key !== 'Enter' && event.key !== 'Select') editing = undefined;

    let handled = true;
    const code = event.keyCode;
    if (hidden && (REVEAL_KEYS.has(event.key) || code === 13)) {
      reveal();
      // A TV's centre button first reveals its transport. Give the next press a useful, native-player-shaped
      // target instead of leaving focus on the now-blurred picture/body where Select cannot do anything.
      if (event.key === 'Enter' || event.key === 'Select' || code === 13)
        root?.querySelector<HTMLElement>('.tv-play-pause')?.focus({ preventScroll: true });
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    reveal();
    // A modal ActionMenu owns navigation inside itself. In particular, do not run the player's spatial search for
    // ArrowUp/ArrowDown: that search also sees the controls behind the dialog and could move focus out of the menu
    // (including onto Close) before the menu's own keyboard handler receives the key.
    const menu = openMenu();
    if (menu?.contains(target as Node)) {
      if (
        event.key === 'ArrowUp' ||
        event.key === 'ArrowDown' ||
        event.key === 'Home' ||
        event.key === 'End' ||
        event.key === 'Enter' ||
        event.key === 'Select'
      )
        return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    const moveControl = (direction: -1 | 1) => {
      if (!(
        target instanceof HTMLButtonElement ||
        target instanceof HTMLAnchorElement ||
        (target instanceof HTMLSelectElement && target !== editing)
      ))
        return false;
      const group = target.closest<HTMLElement>(
        '[data-tv-horizontal-group], .tv-transport, .controls, header',
      );
      if (!group) return false;
      const controlsIn = (container: HTMLElement) =>
        [
          ...container.querySelectorAll<HTMLElement>(
            'button:not([disabled]), a[href], select:not([disabled])',
          ),
        ].sort(
          (left, right) => left.getBoundingClientRect().left - right.getBoundingClientRect().left,
        );
      const controls = controlsIn(group);
      const index = controls.indexOf(target);
      const next = controls[index + direction];
      if (next) {
        next.focus({ preventScroll: true });
        return true;
      }
      // Transport and custom actions are two visual rows but one horizontal remote sequence. Explicit groups
      // make that relationship stable when optional Audio, Subtitles, Streams or Next controls disappear.
      if (!group.hasAttribute('data-tv-horizontal-group')) return false;
      const groups = [...root!.querySelectorAll<HTMLElement>('[data-tv-horizontal-group]')];
      const adjacent = groups[groups.indexOf(group) + direction];
      const across = adjacent && controlsIn(adjacent);
      const boundary = across?.[direction > 0 ? 0 : across.length - 1];
      if (!boundary) return false;
      boundary.focus({ preventScroll: true });
      return true;
    };
    const moveSpatial = (direction: 'up' | 'down') => {
      if (!root) return false;
      const controls = [
        ...root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((control) => {
        if (control.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
        const style = getComputedStyle(control);
        const rect = control.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 1 &&
          rect.height > 1
        );
      });
      const current =
        target instanceof HTMLElement && controls.includes(target) ? target : undefined;
      if (!current) {
        const fallback = root.querySelector<HTMLElement>(
          '.tv-transport button, .tv-transport a, header button, footer select, footer button, footer a',
        );
        fallback?.focus({ preventScroll: true });
        return !!fallback;
      }
      const from = current.getBoundingClientRect();
      const x = from.left + from.width / 2;
      const y = from.top + from.height / 2;
      let winner: HTMLElement | undefined;
      let best = Infinity;
      for (const control of controls) {
        if (control === current) continue;
        const rect = control.getBoundingClientRect();
        const dx = Math.abs(rect.left + rect.width / 2 - x);
        const dy = rect.top + rect.height / 2 - y;
        const primary = direction === 'down' ? dy : -dy;
        if (primary <= 2) continue;
        const score = primary + dx * 3;
        if (score < best) {
          best = score;
          winner = control;
        }
      }
      winner?.focus({ preventScroll: true });
      winner?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return !!winner;
    };
    const stepSelect = (select: HTMLSelectElement, direction: -1 | 1) => {
      for (
        let index = select.selectedIndex + direction;
        index >= 0 && index < select.options.length;
        index += direction
      ) {
        if (select.options[index]?.disabled) continue;
        select.selectedIndex = index;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    };
    if (PLAY_KEYS.has(event.key) || code === 415 || code === 10252) {
      if (event.key === 'MediaPlayPause' || code === 10252) {
        if (actions.paused()) void actions.play();
        else actions.pause();
      } else void actions.play();
    } else if (PAUSE_KEYS.has(event.key) || code === 19 || code === 413) {
      actions.pause();
      revealPaused();
    } else if (code === 412) actions.seekBy(-10);
    else if (code === 417) actions.seekBy(10);
    else if (event.key === 'ArrowLeft' && moveControl(-1)) void 0;
    else if (event.key === 'ArrowRight' && moveControl(1)) void 0;
    else if (target instanceof HTMLSelectElement && editing && event.key === 'ArrowUp')
      stepSelect(target, -1);
    else if (target instanceof HTMLSelectElement && editing && event.key === 'ArrowDown')
      stepSelect(target, 1);
    else if (
      event.key === 'ArrowUp' &&
      target instanceof HTMLElement &&
      target.closest('.tv-details') &&
      closeDetails()
    )
      void 0;
    else if (event.key === 'ArrowUp' && moveSpatial('up')) void 0;
    else if (event.key === 'ArrowDown' && moveSpatial('down')) void 0;
    else if (event.key === 'ArrowDown' && interactive && actions.showDetails) {
      detailsOrigin = target instanceof HTMLElement ? target : undefined;
      actions.showDetails();
      clearTimeout(hideTimer);
    } else if (!interactive && event.key === 'ArrowLeft') actions.seekBy(-10);
    else if (!interactive && event.key === 'ArrowRight') actions.seekBy(10);
    else if (event.key === 'MediaTrackNext' && actions.next) actions.next();
    else if (
      (event.key === 'Enter' || event.key === 'Select' || code === 13) &&
      target instanceof HTMLSelectElement
    )
      editing = editing === target ? undefined : target;
    else if (
      event.key === 'Escape' ||
      event.key === 'Back' ||
      event.key === 'BrowserBack' ||
      code === 461 ||
      code === 10009
    ) {
      // This capture listener runs before ActionMenu's own handler. Close its TV dialog here so a fast Back cannot
      // remove the player underneath it; this also works in the standalone player shell without route navigation.
      if (!closeOpenMenu() && !closeDetails()) {
        // Back first leaves the select's remote edit mode. Closing the entire film while the viewer is
        // choosing a track makes a native TV picker impossible to cancel safely.
        if (editing) editing = undefined;
        else actions.close();
      }
    } else handled = false;

    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const onBack = (event: Event) => {
    // Global TV navigation sends this before handling its own modal fallback. Consuming it after closing the
    // player's menu prevents the same Back from reaching the player underneath.
    if (closeOpenMenu() || actions.closeSubtitleTiming?.() || closeDetails()) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    if (editing) editing = undefined;
    else actions.close();
  };

  const onPlay = () => scheduleHide();
  const onPause = () => revealPaused();
  // LG's Magic Remote is primarily a pointer: revealing only after a click leaves an invisible control surface
  // under its cursor. Motion should behave like motion over a native player and keep the overlay around while the
  // viewer is aiming; `reveal` also restarts the same idle timer, so it disappears normally once they stop.
  const onPointer = () => reveal();
  const onMenuClose = (event: Event) => {
    if (event.target instanceof HTMLDialogElement && event.target.matches('[role="menu"]'))
      scheduleHide();
  };

  addEventListener('keydown', onKey, { capture: true });
  addEventListener('den:tv-back', onBack);
  document.addEventListener('play', onPlay, { capture: true });
  document.addEventListener('pause', onPause, { capture: true });
  document.addEventListener('pointerdown', onPointer, { capture: true });
  document.addEventListener('pointermove', onPointer, { capture: true });
  document.addEventListener('close', onMenuClose, { capture: true });
  scheduleHide();
  return () => {
    clearTimeout(hideTimer);
    setHidden(false);
    removeEventListener('keydown', onKey, { capture: true });
    removeEventListener('den:tv-back', onBack);
    document.removeEventListener('play', onPlay, { capture: true });
    document.removeEventListener('pause', onPause, { capture: true });
    document.removeEventListener('pointerdown', onPointer, { capture: true });
    document.removeEventListener('pointermove', onPointer, { capture: true });
    document.removeEventListener('close', onMenuClose, { capture: true });
  };
}
import './player.css';
