export interface TvRemoteActions {
  close(): void;
  next?(): void;
  pause(): void;
  play(): void | Promise<void>;
  seekBy(seconds: number): void;
  paused(): boolean;
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
  const root = document.querySelector<HTMLElement>('.player');
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
    if (!actions.paused()) hideTimer = setTimeout(() => setHidden(true), HIDE_MS);
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
    const target = event.target;
    const interactive =
      target instanceof HTMLSelectElement ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLButtonElement ||
      target instanceof HTMLAnchorElement;

    let handled = true;
    const code = event.keyCode;
    if (hidden && (REVEAL_KEYS.has(event.key) || code === 13)) {
      reveal();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    reveal();
    const moveControl = (direction: -1 | 1) => {
      if (!(target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement))
        return false;
      const group = target.closest<HTMLElement>('.tv-transport, .controls, header');
      if (!group) return false;
      const controls = [
        ...group.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], select:not([disabled])',
        ),
      ];
      const index = controls.indexOf(target);
      const next = controls[index + direction];
      if (!next) return false;
      next.focus({ preventScroll: true });
      return true;
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
    else if (!interactive && event.key === 'ArrowLeft') actions.seekBy(-10);
    else if (!interactive && event.key === 'ArrowRight') actions.seekBy(10);
    else if (event.key === 'MediaTrackNext' && actions.next) actions.next();
    else if (event.key === 'Back' || event.key === 'BrowserBack' || code === 461 || code === 10009)
      actions.close();
    else handled = false;

    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const onBack = (event: Event) => {
    event.preventDefault();
    actions.close();
  };

  const onPlay = () => scheduleHide();
  const onPause = () => revealPaused();
  const onPointer = () => reveal();

  addEventListener('keydown', onKey, { capture: true });
  addEventListener('den:tv-back', onBack);
  document.addEventListener('play', onPlay, { capture: true });
  document.addEventListener('pause', onPause, { capture: true });
  document.addEventListener('pointerdown', onPointer, { capture: true });
  scheduleHide();
  return () => {
    clearTimeout(hideTimer);
    setHidden(false);
    removeEventListener('keydown', onKey, { capture: true });
    removeEventListener('den:tv-back', onBack);
    document.removeEventListener('play', onPlay, { capture: true });
    document.removeEventListener('pause', onPause, { capture: true });
    document.removeEventListener('pointerdown', onPointer, { capture: true });
  };
}
import './player.css';
