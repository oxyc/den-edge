import { describe, expect, it, vi } from 'vitest';
import { resetProfileNavigation } from './profileNavigation';

describe('profile navigation reset', () => {
  it('replaces the current route with Home instead of adding a history destination', () => {
    const dispatchEvent = vi.fn((_event: Event) => true);

    resetProfileNavigation({ dispatchEvent } as unknown as EventTarget);

    expect(dispatchEvent).toHaveBeenCalledOnce();
    const event = dispatchEvent.mock.calls[0]![0] as CustomEvent;
    expect(event.type).toBe('den:navigate');
    expect(event.detail).toEqual({ path: '/', replace: true });
  });
});
