import { afterEach, expect, it, vi } from 'vitest';
import { keyboardInput, trackInputModality } from './inputModality';

afterEach(() => vi.unstubAllGlobals());

it('shares cleaned document listeners and tracks the latest input kind', () => {
  const handlers = new Map<string, EventListener>();
  const add = vi.fn((type: string, handler: EventListener) => handlers.set(type, handler));
  const remove = vi.fn((type: string) => handlers.delete(type));
  vi.stubGlobal('document', { addEventListener: add, removeEventListener: remove });
  const stopFirst = trackInputModality();
  const stopSecond = trackInputModality();

  expect(add).toHaveBeenCalledTimes(2);
  handlers.get('keydown')?.(new Event('keydown'));
  expect(keyboardInput()).toBe(true);
  handlers.get('pointerdown')?.(new Event('pointerdown'));
  expect(keyboardInput()).toBe(false);
  stopFirst();
  expect(remove).not.toHaveBeenCalled();
  stopSecond();
  expect(remove).toHaveBeenCalledTimes(2);
});
