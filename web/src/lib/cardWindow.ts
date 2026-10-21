export interface CardWindow {
  start: number;
  end: number;
}

/** Fill what is on screen first, then the window's leading and trailing overscan. */
export function cardMaterializationOrder(window: CardWindow, viewport: CardWindow): number[] {
  return [
    ...Array.from({ length: viewport.end - viewport.start }, (_, i) => viewport.start + i),
    ...Array.from({ length: viewport.start - window.start }, (_, i) => viewport.start - i - 1),
    ...Array.from({ length: window.end - viewport.end }, (_, i) => viewport.end + i),
  ];
}

/** The cards worth mounting around a horizontal track's viewport; every other title keeps a light slot. */
export function cardWindow(
  count: number,
  scrollLeft: number,
  viewportWidth: number,
  cardWidth: number,
  gap: number,
  overscanScreens = 1,
): CardWindow {
  if (count <= 0 || viewportWidth <= 0 || cardWidth <= 0) return { start: 0, end: 0 };
  const stride = cardWidth + gap;
  const overscan = viewportWidth * overscanScreens;
  const start = Math.max(0, Math.floor((scrollLeft - overscan) / stride));
  const end = Math.min(
    count,
    Math.max(start + 1, Math.ceil((scrollLeft + viewportWidth + overscan + gap) / stride)),
  );
  return { start, end };
}

/**
 * The cards inside or touching a horizontal track's content box, its gutter padding excluded. That is where each
 * card's own viewport observer found a card visible: measured in Chromium on PosterRow's 48px-gutter track, a card 8px
 * into the right gutter, or 1px into the left one, was reported outside, and one exactly at either edge inside.
 */
export function cardsOnScreen(
  count: number,
  scrollLeft: number,
  contentWidth: number,
  cardWidth: number,
  gap: number,
): CardWindow {
  if (count <= 0 || contentWidth <= 0 || cardWidth <= 0) return { start: 0, end: 0 };
  const stride = cardWidth + gap;
  const end = Math.min(count, Math.floor((scrollLeft + contentWidth) / stride) + 1);
  const start = Math.max(0, Math.ceil((scrollLeft - cardWidth) / stride));
  return { start: Math.min(start, end), end };
}

/** PosterRow's responsive card width, in CSS pixels. Keep these clamps paired with its CSS source token. */
export function posterCardWidth(viewportWidth: number, tv = __DEN_TV__): number {
  return tv
    ? Math.min(260, Math.max(190, viewportWidth * 0.13))
    : Math.min(190, Math.max(140, viewportWidth * 0.38));
}
