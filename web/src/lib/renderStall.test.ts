import { describe, expect, it } from 'vitest';
import { hasRendered } from './renderStall';

// A page reduced to the selectors the watchdog may ask about, so the test needs no DOM.
const page = (present: string[]) => ({
  querySelector: (selector: string) =>
    present.some((marker) => selector.split(',').some((part) => part.trim() === marker))
      ? ({} as Element)
      : null,
});

describe('hasRendered', () => {
  it('accepts an active route page', () => {
    expect(hasRendered(page(['[data-route-page][data-active="true"]']))).toBe(true);
  });

  it('accepts the pairing screen and a screen that failed to load', () => {
    expect(hasRendered(page(['[data-startup-outcome]']))).toBe(true);
  });

  it('does not accept a page with nothing rendered, or a spinner', () => {
    expect(hasRendered(page([]))).toBe(false);
    expect(hasRendered(page(['.loading']))).toBe(false);
  });
});
