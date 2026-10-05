export interface CardWindow {
  start: number;
  end: number;
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

/** PosterRow's responsive card width, in CSS pixels. */
export function posterCardWidth(viewportWidth: number): number {
  return Math.min(190, Math.max(140, viewportWidth * 0.38));
}
