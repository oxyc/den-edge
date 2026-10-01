import { afterEach, expect, it, vi } from 'vitest';
import { isBackSwipe, swipeHistory } from './swipeBack';
it('requires a deliberate rightward swipe, not left, short, vertical or diagonal motion', () => {
  expect(isBackSwipe(100, 12)).toBe(true);
  for (const [x, y] of [
    [-100, 0],
    [40, 0],
    [100, 100],
    [5, 180],
    [100, -80],
  ]) {
    expect(isBackSwipe(x!, y!)).toBe(false);
  }
});

// Exercise gesture ownership without requiring a browser's native history animation.
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  vi.unstubAllGlobals();
});
function gestureHarness(rail = false, { noSwipe = false, selected = '' } = {}) {
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('getComputedStyle', () => ({ overflowX: rail ? 'auto' : 'visible' }));
  const element = {
    closest: (selector: string) => (noSwipe && selector.includes('[data-no-swipe]') ? {} : null),
    parentElement: null,
    scrollWidth: rail ? 800 : 390,
    clientWidth: 390,
  };
  const document = Object.assign(new EventTarget(), {
    getSelection: () => ({ toString: () => selected }),
  });
  const preview = {
    move: vi.fn(),
    finish: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  const destination = () => ({
    canNavigate: () => true,
    navigate: vi.fn(),
    preview: vi.fn(() => preview),
  });
  const back = destination(),
    forward = destination();
  stop = swipeHistory(document as Document, { back, forward });
  const send = (type: string, x: number, y = 300) => {
    const event = new Event(type, { cancelable: true });
    const touch = { identifier: 1, clientX: x, clientY: y };
    Object.defineProperties(event, {
      target: { value: element },
      touches: { value: type === 'touchend' ? [] : [touch] },
      changedTouches: { value: [touch] },
    });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { send, back, forward, preview, document };
}
it('accepts leftward Forward away from the edge and snapshots only after horizontal intent', async () => {
  const { send, forward, back } = gestureHarness();
  expect(send('touchstart', 300)).toBe(false);
  expect(forward.preview).not.toHaveBeenCalled();
  expect(send('touchmove', 240)).toBe(true);
  expect(forward.preview).toHaveBeenCalledOnce();
  send('touchend', 150);
  await Promise.resolve();
  expect(forward.navigate).toHaveBeenCalledOnce();
  expect(back.navigate).not.toHaveBeenCalled();
});
it('claims a right-edge Forward swipe even over a carousel', async () => {
  const { send, forward } = gestureHarness(true);
  expect(send('touchstart', 385)).toBe(true);
  expect(forward.preview).not.toHaveBeenCalled();
  expect(send('touchmove', 300)).toBe(true);
  send('touchend', 230);
  await Promise.resolve();
  expect(forward.navigate).toHaveBeenCalledOnce();
});
it('leaves a drag on text marked to be selected alone, such as a code to copy', () => {
  const { send, forward } = gestureHarness(false, { noSwipe: true });
  expect(send('touchstart', 300)).toBe(false);
  expect(send('touchmove', 200)).toBe(false);
  expect(forward.preview).not.toHaveBeenCalled();
});
it('does not turn the page while a selection is being dragged', () => {
  const { send, forward } = gestureHarness(false, { selected: 'ABCD-1234' });
  send('touchstart', 300);
  expect(send('touchmove', 200)).toBe(false);
  expect(forward.preview).not.toHaveBeenCalled();
});
it('leaves interior carousel drags to the carousel', () => {
  const { send, forward, back } = gestureHarness(true);
  expect(send('touchstart', 300)).toBe(false);
  expect(send('touchmove', 200)).toBe(false);
  send('touchend', 150);
  expect(forward.preview).not.toHaveBeenCalled();
  expect(back.preview).not.toHaveBeenCalled();
});
it('leaves vertical interior scrolling alone without cloning the page', () => {
  const { send, forward, back } = gestureHarness();
  expect(send('touchstart', 300)).toBe(false);
  expect(send('touchmove', 298, 350)).toBe(false);
  expect(send('touchend', 295, 420)).toBe(false);
  expect(forward.preview).not.toHaveBeenCalled();
  expect(back.preview).not.toHaveBeenCalled();
});

it('listens to moves only while a touch could become a swipe', () => {
  const { send, document } = gestureHarness(true);
  const added = vi.spyOn(document, 'addEventListener');
  const removed = vi.spyOn(document, 'removeEventListener');
  const moves = (spy: typeof added) => spy.mock.calls.filter(([type]) => type === 'touchmove');
  // A carousel swiped from inside is the carousel's: nothing here may hold its scrolling up.
  send('touchstart', 300);
  send('touchmove', 200);
  send('touchend', 150);
  expect(moves(added)).toHaveLength(0);
  // An edge touch is followed, and let go of once it turns out to be a scroll.
  send('touchstart', 385);
  expect(moves(added)).toEqual([
    ['touchmove', expect.any(Function), { passive: false, capture: true }],
  ]);
  send('touchmove', 384, 360);
  expect(moves(removed)).toHaveLength(1);
});
it('reads whether an element is a carousel once, not on every touch', () => {
  const { send } = gestureHarness(true);
  const style = vi.fn(() => ({ overflowX: 'auto' }));
  vi.stubGlobal('getComputedStyle', style);
  for (let i = 0; i < 3; i++) {
    send('touchstart', 300);
    send('touchend', 300);
  }
  expect(style).toHaveBeenCalledOnce();
});

it('does not traverse a changed history entry when navigation interrupts a finishing swipe', async () => {
  const { send, back, preview, document } = gestureHarness();
  let finish!: () => void;
  preview.finish.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  send('touchstart', 5);
  send('touchmove', 100);
  send('touchend', 150);
  document.dispatchEvent(new Event('den:swipe-cancel'));
  finish();
  await Promise.resolve();
  expect(back.navigate).not.toHaveBeenCalled();
  expect(preview.dispose).toHaveBeenCalledOnce();
});
