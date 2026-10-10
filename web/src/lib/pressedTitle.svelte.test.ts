import { describe, expect, it } from 'vitest';
import { blankTitle } from './actions';
import { PressedTitle } from './pressedTitle.svelte';

const dune = blankTitle({ type: 'movie', id: 693134 }, 1000);

describe('PressedTitle', () => {
  it('shows a press from the moment it is made until its own save ends', () => {
    const pressed = new PressedTitle();
    expect(pressed.idle).toBe(true);
    pressed.begin('reaction', 'love', 'love');
    expect(pressed.idle).toBe(false);
    expect(pressed.state(dune).reaction).toBe('love');
    expect(pressed.saving('reaction')).toBe(true);
    expect(pressed.saving('reaction', 'love')).toBe(true);
    // Only the control that was pressed is saving, not the others beside it.
    expect(pressed.saving('reaction', 'like')).toBe(false);
    expect(pressed.saving('watchlist')).toBe(false);

    pressed.end();
    expect(pressed.idle).toBe(true);
    expect(pressed.state(dune).reaction).toBeNull();
    expect(pressed.saving('reaction')).toBe(false);
  });

  it('does not move a press back when the row refreshes under it', () => {
    const pressed = new PressedTitle();
    pressed.begin('watchlist', true);
    const refreshed = { ...dune, addedAt: 5000 };
    expect(pressed.state(dune).listed).toBe(true);
    expect(pressed.state(refreshed).listed).toBe(true);
  });

  it('takes a failed press back out, leaving the row as it was', () => {
    const pressed = new PressedTitle();
    pressed.begin('seen', true);
    expect(pressed.state(dune).seen).toBe(true);
    pressed.end();
    expect(pressed.state(dune)).toEqual({ listed: false, seen: false, reaction: null });
  });
});
