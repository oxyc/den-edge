/** Share the two document-level input-modality listeners across retained route pages. */
let keyboard = false;
let users = 0;

const keydown = () => (keyboard = true);
const pointerdown = () => (keyboard = false);
const listen = { capture: true, passive: true } as const;

export function keyboardInput(): boolean {
  return keyboard;
}

/** Acquire input-modality tracking; the last mounted route page releases it. */
export function trackInputModality(): () => void {
  if (typeof document === 'undefined') return () => {};
  if (users++ === 0) {
    document.addEventListener('keydown', keydown, listen);
    document.addEventListener('pointerdown', pointerdown, listen);
  }
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    if (--users === 0) {
      document.removeEventListener('keydown', keydown, listen);
      document.removeEventListener('pointerdown', pointerdown, listen);
    }
  };
}
