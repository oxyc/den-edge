import { expect, it, vi } from 'vitest';
import { NearViewportObservers } from './nearViewport';

it('shares one observer per margin and releases it with its final target', () => {
  const made: FakeObserver[] = [];
  const pool = new NearViewportObservers((callback, options) => {
    const observer = new FakeObserver(callback, options);
    made.push(observer);
    return observer as unknown as IntersectionObserver;
  });
  const first = {} as Element;
  const second = {} as Element;
  const firstSeen = vi.fn();
  const secondSeen = vi.fn();
  const stopFirst = pool.observe(first, firstSeen, '100px 0px');
  const stopSecond = pool.observe(second, secondSeen, '100px 0px');

  expect(made).toHaveLength(1);
  expect(made[0]?.observed).toEqual(new Set([first, second]));
  made[0]?.emit(first, true);
  expect(firstSeen).toHaveBeenLastCalledWith(true);
  expect(secondSeen).not.toHaveBeenCalled();

  stopFirst();
  expect(made[0]?.unobserved).toEqual([first]);
  expect(made[0]?.disconnected).toBe(false);
  stopSecond();
  expect(made[0]?.disconnected).toBe(true);
});

it('fans one target out to subscribers and remembers its current state', () => {
  let made!: FakeObserver;
  const pool = new NearViewportObservers((callback, options) => {
    made = new FakeObserver(callback, options);
    return made as unknown as IntersectionObserver;
  });
  const target = {} as Element;
  const first = vi.fn();
  const second = vi.fn();
  const stopFirst = pool.observe(target, first, '50px');
  made.emit(target, false);
  const stopSecond = pool.observe(target, second, '50px');
  expect(second).toHaveBeenCalledWith(false);
  made.emit(target, true);
  expect(first).toHaveBeenLastCalledWith(true);
  expect(second).toHaveBeenLastCalledWith(true);
  stopFirst();
  stopSecond();
});

it('ignores a queued delivery after its target was unsubscribed', () => {
  let made!: FakeObserver;
  const pool = new NearViewportObservers((callback, options) => {
    made = new FakeObserver(callback, options);
    return made as unknown as IntersectionObserver;
  });
  const removed = {} as Element;
  const keeper = {} as Element;
  const stopRemoved = pool.observe(removed, vi.fn(), '50px');
  const stopKeeper = pool.observe(keeper, vi.fn(), '50px');

  stopRemoved();
  made.emit(removed, true);
  const later = vi.fn();
  const stopLater = pool.observe(removed, later, '50px');
  expect(later).not.toHaveBeenCalled();

  stopLater();
  stopKeeper();
});

class FakeObserver {
  observed = new Set<Element>();
  unobserved: Element[] = [];
  disconnected = false;

  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit,
  ) {}

  observe(element: Element) {
    this.observed.add(element);
  }

  unobserve(element: Element) {
    this.observed.delete(element);
    this.unobserved.push(element);
  }

  disconnect() {
    this.disconnected = true;
  }

  emit(target: Element, isIntersecting: boolean) {
    this.callback([{ target, isIntersecting } as IntersectionObserverEntry], this as never);
  }
}
