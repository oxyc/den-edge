import { afterEach, describe, expect, it } from 'vitest';
import { forgetWarmOnIntent, warmOnIntent } from './warmOnIntent';

/** A press that lands on a link to `href`, or on nothing that is a link at all. */
const press = (on: EventTarget, href: string | null) => {
  const event = new Event('pointerdown');
  // The listener reads `event.target.closest('a[href]')`. An own property shadows the prototype's
  // getter, which is what lets a press be described here without a DOM at all.
  Object.defineProperty(event, 'target', {
    configurable: true,
    value: { closest: () => (href === null ? null : { getAttribute: () => href }) },
  });
  on.dispatchEvent(event);
};

// The listener and the last-pressed title are module state, so one test's registration would otherwise
// decide whether the next one registers a listener of its own.
afterEach(forgetWarmOnIntent);

describe('warmOnIntent', () => {
  it('warms the title a press is heading to', () => {
    const warmed: unknown[] = [];
    const on = new EventTarget();
    warmOnIntent((ref) => warmed.push(ref), on);
    press(on, '/movie/42-the-movie');
    expect(warmed).toEqual([{ type: 'movie', id: 42 }]);
  });

  /**
   * The regression this exists for.
   *
   * `Library` is rendered inside the router's per-route snippet and the router keeps several routes
   * mounted, so this was registered once per instance. Each registration held its own idea of the last
   * title pressed, so none of them de-duplicated the others: measured from a phone, one press produced
   * three `/meta` lookups within 16 ms and three `/sources` asks, and reel resolved the same trailer
   * three times over.
   */
  it('warms once however many callers have asked to be told', () => {
    let warms = 0;
    const on = new EventTarget();
    warmOnIntent(() => warms++, on);
    warmOnIntent(() => warms++, on);
    warmOnIntent(() => warms++, on);
    press(on, '/movie/42-the-movie');
    expect(warms).toBe(1);
  });

  it('is one warm-up for the same title pressed twice, and a new one for the next', () => {
    const warmed: unknown[] = [];
    const on = new EventTarget();
    warmOnIntent((ref) => warmed.push(ref), on);
    press(on, '/movie/42-the-movie');
    press(on, '/movie/42-the-movie');
    expect(warmed, 'a second press tells reel nothing it is not already doing').toHaveLength(1);
    press(on, '/tv/7-a-series');
    expect(warmed).toEqual([
      { type: 'movie', id: 42 },
      { type: 'tv', id: 7 },
    ]);
  });

  it('ignores a press that is not heading to a title', () => {
    let warms = 0;
    const on = new EventTarget();
    warmOnIntent(() => warms++, on);
    press(on, null);
    press(on, '/settings');
    expect(warms).toBe(0);
  });

  it('keeps listening when a caller the router has dropped tears down', () => {
    let warms = 0;
    const on = new EventTarget();
    const stale = warmOnIntent(() => warms++, on);
    warmOnIntent(() => warms++, on);
    // The instance that registered first goes away. Its teardown must not take the live one's listener.
    stale();
    press(on, '/movie/42-the-movie');
    expect(warms).toBe(1);
  });

  it('stops when the caller still in force tears down', () => {
    let warms = 0;
    const on = new EventTarget();
    const stop = warmOnIntent(() => warms++, on);
    stop();
    press(on, '/movie/42-the-movie');
    expect(warms).toBe(0);
  });
});
