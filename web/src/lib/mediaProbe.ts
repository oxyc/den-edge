/**
 * TEMPORARY. Finds the media that keeps playing audio on macOS Safari.
 *
 * Two instruments, because each has a blind spot the other covers.
 *
 * `play()` is wrapped, which catches anything script starts — including an element already detached,
 * which `document.querySelectorAll` cannot reach and which WebKit keeps playing. But an element with an
 * `autoplay` attribute never calls `play()` at all, and Svelte builds elements by cloning a template
 * rather than through `createElement`, so neither wrapping `play()` nor wrapping `createElement` sees
 * one arrive.
 *
 * So the document is watched as well: every media element that ever enters it is recorded, however it
 * was made, and stays recorded after it leaves. Between the two, an element has to avoid being played by
 * script AND never appear in the document at all to stay hidden.
 *
 * Holding the elements keeps them from being collected, which is the point: it is the only way to read
 * one that nothing else still points at.
 */
export type Started = {
  element: HTMLMediaElement;
  /** Where it came from: the stack that called `play()`, or how it was first noticed. */
  from: string;
};

/** Everything script has started. */
export const started: Started[] = [];

/** Everything that has ever been in the document, whether or not it is still there. */
export const seen: Started[] = [];

function note(node: Node, how: string): void {
  if (node instanceof HTMLMediaElement && !seen.some((entry) => entry.element === node))
    seen.push({ element: node, from: how });
  if (node instanceof Element)
    node.querySelectorAll('video, audio').forEach((found) => note(found, how));
}

/** Both instruments, before anything mounts. */
export function watchMedia(): void {
  if (typeof HTMLMediaElement === 'undefined') return;
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement): Promise<void> {
    if (!started.some((entry) => entry.element === this))
      started.push({ element: this, from: new Error().stack ?? '' });
    return play.call(this);
  };
  if (typeof MutationObserver === 'undefined') return;
  new MutationObserver((records) => {
    for (const record of records)
      record.addedNodes.forEach((node) => note(node, 'entered the document'));
  }).observe(document.documentElement, { childList: true, subtree: true });
}
