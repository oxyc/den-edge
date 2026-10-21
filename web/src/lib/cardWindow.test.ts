import { expect, it } from 'vitest';
import { cardMaterializationOrder, cardWindow, cardsOnScreen, posterCardWidth } from './cardWindow';

it('materializes the viewport before either overscan edge', () => {
  expect(cardMaterializationOrder({ start: 2, end: 10 }, { start: 4, end: 7 })).toEqual([
    4, 5, 6, 3, 2, 7, 8, 9,
  ]);
});

it('keeps only the visible cards and one screen either side', () => {
  expect(cardWindow(100, 0, 1000, 190, 14)).toEqual({ start: 0, end: 10 });
  expect(cardWindow(100, 10_000, 1000, 190, 14)).toEqual({ start: 44, end: 59 });
  expect(cardWindow(100, 19_400, 1000, 190, 14)).toEqual({ start: 90, end: 100 });
});

it('never caps the result range and handles small responsive cards', () => {
  const width = posterCardWidth(390);
  expect(width).toBe(148.2);
  const visited = new Set<number>();
  for (let left = 0; left < 200 * (width + 14); left += 390) {
    const window = cardWindow(200, left, 390, width, 14);
    for (let index = window.start; index < window.end; index++) visited.add(index);
  }
  const last = cardWindow(200, Number.MAX_SAFE_INTEGER, 390, width, 14);
  for (let index = last.start; index < last.end; index++) visited.add(index);
  expect(visited.size).toBe(200);
});

it('counts a card on screen while it is inside or touching the track’s content box', () => {
  // A 1280px track with 48px gutters, 190px cards 14px apart, as measured from each card's own observer.
  expect(cardsOnScreen(100, 0, 1184, 190, 14)).toEqual({ start: 0, end: 6 });
  expect(cardsOnScreen(100, 237, 1184, 190, 14)).toEqual({ start: 1, end: 7 });
  expect(cardsOnScreen(100, 2041, 1184, 190, 14)).toEqual({ start: 10, end: 16 });
  // Card 6 starts at 1224: it counts from the scroll that brings it to the content box's edge.
  expect(cardsOnScreen(100, 39, 1184, 190, 14)).toEqual({ start: 0, end: 6 });
  expect(cardsOnScreen(100, 40, 1184, 190, 14)).toEqual({ start: 0, end: 7 });
  // Card 0 ends at 190: it counts until the scroll takes it past the edge.
  expect(cardsOnScreen(100, 190, 1184, 190, 14)).toEqual({ start: 0, end: 7 });
  expect(cardsOnScreen(100, 191, 1184, 190, 14)).toEqual({ start: 1, end: 7 });
  expect(cardsOnScreen(8, 10_000, 1184, 190, 14)).toEqual({ start: 8, end: 8 });
  expect(cardsOnScreen(0, 0, 1184, 190, 14)).toEqual({ start: 0, end: 0 });
});

it('uses the same clamp as PosterRow CSS', () => {
  expect(posterCardWidth(320)).toBe(140);
  expect(posterCardWidth(390)).toBeCloseTo(148.2);
  expect(posterCardWidth(1280)).toBe(190);
  expect(posterCardWidth(1920, true)).toBeCloseTo(249.6);
});
