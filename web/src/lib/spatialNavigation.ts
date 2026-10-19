/** Directional focus geometry shared by the browser enhancement and TV remote adapter. */
export type Direction = 'left' | 'right' | 'up' | 'down';

export const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export const isEditable = (element: Element | null): element is HTMLElement => {
  if (!(element instanceof HTMLElement)) return false;
  const control = element.closest('input, textarea, select, [contenteditable="true"]');
  if (!control) return false;
  if (!(control instanceof HTMLInputElement)) return true;
  return ![
    'checkbox',
    'radio',
    'button',
    'submit',
    'reset',
    'range',
    'color',
    'file',
    'image',
    'hidden',
  ].includes(control.type);
};

export function visible(
  element: HTMLElement,
  ancestry = new WeakMap<HTMLElement, boolean>(),
): boolean {
  if (element.hidden || element.matches(':disabled, [aria-disabled="true"]')) return false;
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const closedDetails = element.closest('details:not([open])');
  if (closedDetails && element !== closedDetails.querySelector(':scope > summary')) return false;
  const checked: HTMLElement[] = [];
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const known = ancestry.get(node);
    if (known === false) return false;
    if (known === true) break;
    const style = getComputedStyle(node);
    // Some native controls deliberately paint through a visible sibling (for example a radio beneath a
    // segmented-control label). They still provide the focus/selection semantics, so an explicit marker lets
    // spatial navigation use their real geometry without making arbitrary visually-hidden inputs reachable.
    const representedControl = node === element && element.hasAttribute('data-spatial-visible');
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      (style.opacity === '0' && !representedControl)
    ) {
      ancestry.set(node, false);
      return false;
    }
    checked.push(node);
  }
  for (const node of checked) ancestry.set(node, true);
  const rect = element.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
}

export const activeDialog = () => document.querySelector<HTMLDialogElement>('dialog[open]');
export const activeModal = () => {
  const modals = Array.from(
    document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"][aria-modal="true"]'),
  ).filter((element) => visible(element));
  return modals[modals.length - 1];
};

export const focusables = () => {
  // Also scope explicitly on engines whose modal dialog implementation does not expose document inertness.
  const root: ParentNode = activeModal() ?? document;
  const ancestry = new WeakMap<HTMLElement, boolean>();
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.tabIndex >= 0 && visible(element, ancestry),
  );
};

export function center(rect: DOMRect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** Prefer the same row/column, while still allowing a diagonal escape at an edge. */
function score(from: DOMRect, to: DOMRect, direction: Direction): number | null {
  const a = center(from);
  const b = center(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const primary =
    direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy;
  if (primary <= 2) return null;
  const secondary = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
  const overlap =
    direction === 'left' || direction === 'right'
      ? Math.max(0, Math.min(from.bottom, to.bottom) - Math.max(from.top, to.top))
      : Math.max(0, Math.min(from.right, to.right) - Math.max(from.left, to.left));
  return primary + secondary * (overlap > 0 ? 2.2 : 4.5);
}

export function moveFocus(direction: Direction): boolean {
  const current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const candidates = focusables();
  if (!candidates.length) return false;
  if (!current || !visible(current) || !candidates.includes(current)) {
    const first = candidates[0]!;
    first.focus({ preventScroll: true });
    first.scrollIntoView({ block: 'center', inline: 'center' });
    return true;
  }
  const from = current.getBoundingClientRect();
  let winner: HTMLElement | undefined;
  let best = Infinity;
  for (const candidate of candidates) {
    // Composite widgets can expose both a focusable child and wrapper. Neither is a spatial neighbor.
    if (candidate === current || candidate.contains(current) || current.contains(candidate))
      continue;
    const value = score(from, candidate.getBoundingClientRect(), direction);
    if (value !== null && value < best) {
      best = value;
      winner = candidate;
    }
  }
  if (!winner) return false;
  winner.focus({ preventScroll: true });
  winner.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  return true;
}
