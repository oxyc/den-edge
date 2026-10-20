/** Share the two document-level input-modality listeners across retained route pages. */
let keyboard = false;
let tracking = false;

const keydown = () => (keyboard = true);
const pointerdown = () => (keyboard = false);
const listen = { capture: true, passive: true } as const;

export function keyboardInput(): boolean {
  return keyboard;
}

/** Start input-modality tracking for this document's lifetime. */
export function trackInputModality(): void {
  if (typeof document !== 'undefined' && !tracking) {
    tracking = true;
    document.addEventListener('keydown', keydown, listen);
    document.addEventListener('pointerdown', pointerdown, listen);
  }
}
