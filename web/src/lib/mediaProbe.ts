/**
 * TEMPORARY. Finds the media element that keeps playing audio on macOS Safari.
 *
 * `document.querySelectorAll` reaches attached nodes only, so an element that was detached while still
 * playing is invisible to it — and a detached element is exactly what emptying `<body>` left audible.
 * Every element that ever starts playing is recorded here instead, with the stack that started it, so an
 * emitter can be named even once it has left the document.
 *
 * Holding the elements keeps them from being collected, which is acceptable for a diagnostic that lives
 * for one release and is the only way to read an object nothing else still points at.
 */
export type Started = {
  element: HTMLMediaElement;
  /** Where `play()` was called from, captured at the first call. */
  from: string;
};

export const started: Started[] = [];

/** Wrap `play()` once, before anything mounts. */
export function watchMedia(): void {
  if (typeof HTMLMediaElement === 'undefined') return;
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement): Promise<void> {
    if (!started.some((entry) => entry.element === this))
      started.push({ element: this, from: new Error().stack ?? '' });
    return play.call(this);
  };
}
