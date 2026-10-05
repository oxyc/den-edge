import { afterEach, expect, it, vi } from 'vitest';
import { observeWindowResize } from './windowEvents';

afterEach(() => vi.unstubAllGlobals());

it('shares and releases the global resize listener', () => {
  const handlers = new Set<EventListener>();
  const add = vi.fn((_type: string, handler: EventListener) => handlers.add(handler));
  const remove = vi.fn((_type: string, handler: EventListener) => handlers.delete(handler));
  vi.stubGlobal('window', { addEventListener: add, removeEventListener: remove });
  const first = vi.fn();
  const second = vi.fn();
  const stopFirst = observeWindowResize(first);
  const stopSecond = observeWindowResize(second);

  expect(add).toHaveBeenCalledOnce();
  handlers.values().next().value?.(new Event('resize'));
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
  stopFirst();
  expect(remove).not.toHaveBeenCalled();
  stopSecond();
  expect(remove).toHaveBeenCalledOnce();
});
