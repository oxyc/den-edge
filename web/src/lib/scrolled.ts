// The elements that have ever scrolled, heard by one listener on the document. A scroll event does not bubble, but
// a capturing listener above an element hears it, so this sees every scroller there is without being told of any.
//
// Finding them by asking every element for its offsets read each of ~1,500 nodes whenever a page was left or
// copied, to find the handful of rows that had moved.

const scrolled = new Set<Element>();

if (typeof document !== 'undefined')
  document.addEventListener(
    'scroll',
    (event) => {
      if (event.target instanceof Element) scrolled.add(event.target);
    },
    { capture: true, passive: true },
  );

/** Every element under `root` (or `root` itself) that has scrolled and is still in the document. */
export function scrolledWithin(root: Element): Element[] {
  const found: Element[] = [];
  for (const element of scrolled) {
    if (!element.isConnected) scrolled.delete(element);
    else if (root.contains(element)) found.push(element);
  }
  return found;
}
