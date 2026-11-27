import { describe, expect, it, vi } from 'vitest';
import { profileRouteAfterSwitch, resetProfileNavigation } from './profileNavigation';

describe('profile navigation reset', () => {
  it.each([
    ['/movie/1002-a-title', '/movie/1002'],
    ['/tv/77-a-series?season=2&episode=3', '/tv/77?season=2&episode=3'],
    ['/tv/77?season=2&episode=3&play=1&source=private', '/tv/77?season=2&episode=3'],
    ['/movie/1002?trailer=1', '/movie/1002'],
    ['/settings', '/'],
    ['/search?q=blade', '/'],
    ['/not-a-route', '/'],
  ])('reopens %s as %s', (path, expected) => {
    expect(profileRouteAfterSwitch(path)).toBe(expected);
  });

  it('replaces the current entry without adding a history destination', () => {
    const dispatchEvent = vi.fn((_event: Event) => true);
    const replaceState = vi.fn();

    resetProfileNavigation(
      { dispatchEvent } as unknown as EventTarget,
      { replaceState },
      '/movie/1002?play=1',
    );

    expect(replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/movie/1002');
    expect(dispatchEvent).toHaveBeenCalledOnce();
    const event = dispatchEvent.mock.calls[0]![0] as CustomEvent;
    expect(event.type).toBe('den:navigate');
    expect(event.detail).toEqual({ path: '/movie/1002' });
  });
});
