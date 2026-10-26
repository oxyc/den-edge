export function supportsSelector(selector: string): boolean {
  try {
    return CSS.supports(`selector(${selector})`);
  } catch {
    return false;
  }
}

// Parsing `gap` is not enough: older Chromium accepts the property while ignoring it in flex layout.
export function supportsFlexGap(): boolean {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;left:-9999px;display:flex;flex-direction:column;row-gap:1px';
  const child = document.createElement('div');
  child.style.height = '1px';
  probe.append(child, child.cloneNode());
  document.body.append(probe);
  const supported = probe.scrollHeight === 3;
  probe.remove();
  return supported;
}

/**
 * Capability classes keep old-engine fallbacks in the TV stylesheet. Components retain ordinary standards-based
 * CSS, and modern LG/Samsung builds pay only these startup checks rather than carrying platform branches.
 */
export function installTvCssCapabilities(): () => void {
  const measured = beginStartupRenderPhase('tv_css');
  const root = document.documentElement;
  const grid = CSS.supports('display', 'grid');
  const flexGap = supportsFlexGap();
  const focusWithin = supportsSelector(':focus-within');
  const customProperties = CSS.supports('--den-css-vars', '1');
  root.classList.toggle('tv-no-grid', !grid);
  // Only without Grid too: the flex-gap fallbacks target containers that are grids elsewhere, and an engine with Grid
  // (Chromium 69 on Tizen 5.5) honours their grid `gap`, so a margin would add to it.
  root.classList.toggle('tv-no-flex-gap', !flexGap && !grid);
  root.classList.toggle('tv-no-focus-within', !focusWithin);
  root.classList.toggle('tv-no-custom-properties', !customProperties);
  measured();

  if (focusWithin) return () => {};

  let focusedAncestors: Element[] = [];
  let pending: ReturnType<typeof setTimeout> | undefined;
  const updateFocusWithin = () => {
    for (const element of focusedAncestors) element.classList.remove('tv-focus-within');
    focusedAncestors = [];
    let element = document.activeElement instanceof Element ? document.activeElement : null;
    while (element && element !== root) {
      element.classList.add('tv-focus-within');
      focusedAncestors.push(element);
      element = element.parentElement;
    }
  };
  const afterFocusOut = () => {
    clearTimeout(pending);
    pending = setTimeout(updateFocusWithin);
  };
  document.addEventListener('focusin', updateFocusWithin);
  document.addEventListener('focusout', afterFocusOut);
  updateFocusWithin();
  return () => {
    clearTimeout(pending);
    document.removeEventListener('focusin', updateFocusWithin);
    document.removeEventListener('focusout', afterFocusOut);
    for (const element of focusedAncestors) element.classList.remove('tv-focus-within');
  };
}
import { beginStartupRenderPhase } from '../lib/startupTiming';
