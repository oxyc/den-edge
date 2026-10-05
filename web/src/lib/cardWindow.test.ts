import { expect, it } from 'vitest';
import { cardWindow, posterCardWidth } from './cardWindow';

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

it('uses the same clamp as PosterRow CSS', () => {
  expect(posterCardWidth(320)).toBe(140);
  expect(posterCardWidth(390)).toBeCloseTo(148.2);
  expect(posterCardWidth(1280)).toBe(190);
});
