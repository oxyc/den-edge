/** Directional focus geometry shared by the browser enhancement and TV remote adapter. */
export type Direction = 'left' | 'right' | 'up' | 'down';

export const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

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
  const shown = (node: HTMLElement | null, representedControl: boolean): boolean => {
    if (!node) return true;
    const known = ancestry.get(node);
    if (known !== undefined) return known;
    const style = getComputedStyle(node);
    // Some native controls deliberately paint through a visible sibling (for example a radio beneath a
    // segmented-control label). They still provide the focus/selection semantics, so an explicit marker lets
    // spatial navigation use their real geometry without making arbitrary visually-hidden inputs reachable.
    const result =
      !(
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        (style.opacity === '0' && !representedControl)
      ) && shown(node.parentElement, false);
    ancestry.set(node, result);
    return result;
  };
  if (!shown(element, element.hasAttribute('data-spatial-visible'))) return false;
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

function firstChoice(region: ParentNode, candidates: HTMLElement[]): HTMLElement | undefined {
  const choices = Array.from(region.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((choice) =>
    candidates.includes(choice),
  );
  return (
    choices.find(
      (choice) => choice instanceof HTMLInputElement && choice.type === 'radio' && choice.checked,
    ) ??
    choices.find((choice) =>
      choice.matches('[aria-current]:not([aria-current="false"]), [aria-pressed="true"]'),
    ) ??
    choices[0]
  );
}

function controlledRegion(root: Document | ShadowRoot, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
}

/** Prefer declared ownership and ordering before falling back to screen geometry. */
function semanticDestination(
  current: HTMLElement,
  direction: Direction,
  candidates: HTMLElement[],
): HTMLElement | undefined {
  const root = current.getRootNode();
  if (!(root instanceof Document || root instanceof ShadowRoot)) return undefined;
  const section = current.closest<HTMLElement>('[data-spatial-section]');

  // Segmented filters and similar declared horizontal lists own Left/Right. Follow their DOM reading order and
  // stop at an edge; page geometry must not jump from All into the first search result beside the rail.
  if (direction === 'left' || direction === 'right') {
    // A vertical content section and the same-page rail link that names it are one horizontal pair. This remains
    // reliable when larger TV rows leave no literal y-axis overlap between a field and its short rail label.
    if (section?.dataset.spatialSection === 'vertical' && direction === 'left' && section.id) {
      const owner = Array.from(
        root.querySelectorAll<HTMLElement>(`nav a[href="#${CSS.escape(section.id)}"]`),
      ).find((link) => candidates.includes(link));
      if (owner) return owner;
    }
    if (direction === 'right' && current.matches('nav a[href^="#"]')) {
      const href = current.getAttribute('href');
      const owned = href?.startsWith('#') ? controlledRegion(root, href.slice(1)) : null;
      const first = owned ? firstChoice(owned, candidates) : undefined;
      if (first) return first;
    }
    const list = current.closest<HTMLElement>('[data-spatial-list="horizontal"]');
    if (list) {
      const choices = Array.from(list.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((choice) =>
        candidates.includes(choice),
      );
      const here = choices.indexOf(current);
      if (here >= 0) {
        const next = choices[here + (direction === 'left' ? -1 : 1)];
        return next ?? current;
      }
    }
    // A declared section is also a horizontal boundary. Geometry still chooses among controls within it, but an
    // edge press stays put instead of escaping to Back, a card, or another visually overlapping section.
    if (section && section.dataset.spatialSection !== 'vertical') {
      const withinSection = candidates.filter((candidate) => section.contains(candidate));
      return geometricDestination(current, direction, withinSection) ?? current;
    }
  }

  // An expanded controller and its region form one vertical unit. This ownership outranks the enclosing page
  // section: Down must enter the disclosed controls, not pick another geometrically nearby row in that section.
  if (direction === 'down' && current.getAttribute('aria-expanded') === 'true') {
    const id = current.getAttribute('aria-controls');
    const region = id ? controlledRegion(root, id) : null;
    const first = region ? firstChoice(region, candidates) : undefined;
    if (first) return first;
  }
  if (direction === 'up') {
    for (let region = current.parentElement; region; region = region.parentElement) {
      if (!region.id) continue;
      const controller = root.querySelector<HTMLElement>(
        `[aria-expanded="true"][aria-controls="${CSS.escape(region.id)}"]`,
      );
      if (
        controller &&
        candidates.includes(controller) &&
        firstChoice(region, candidates) === current
      )
        return controller;
    }
  }

  // Some visual rows contain differently sized controls. Their declared DOM order outranks the geometry of an
  // enclosing page section; the checked radio is the representative focus stop for a segmented control.
  if (direction === 'up' || direction === 'down') {
    const anchor = current.closest<HTMLElement>('[data-spatial-anchor]');
    const item = anchor?.closest<HTMLElement>('[data-spatial-item]');
    const list = item?.parentElement;
    if (item && list?.matches('[data-spatial-list="vertical"]')) {
      let sibling = direction === 'down' ? item.nextElementSibling : item.previousElementSibling;
      while (sibling && !sibling.matches('[data-spatial-item]'))
        sibling =
          direction === 'down' ? sibling.nextElementSibling : sibling.previousElementSibling;
      if (sibling) {
        const next = firstChoice(sibling, candidates);
        if (next) return next;
      }
    }
  }

  // Components can declare whole navigation sections without hard-coding one section's controls into another.
  // Vertical movement first stays inside the current section; at its edge it enters the nearest declared section
  // in that direction. This is the reusable boundary between title actions and season controls, settings groups,
  // and any later toolbar/list pair whose visually nearest element is not its semantic parent.
  if (direction === 'up' || direction === 'down') {
    if (section) {
      const withinSection = candidates.filter((candidate) => section.contains(candidate));
      const inside = geometricDestination(current, direction, withinSection);
      if (inside) return inside;

      const from = current.getBoundingClientRect();
      let nextSection: HTMLElement | undefined;
      let nextScore = Infinity;
      for (const candidate of root.querySelectorAll<HTMLElement>('[data-spatial-section]')) {
        if (candidate === section || candidate.contains(section) || section.contains(candidate))
          continue;
        const sectionCandidates = candidates.filter((choice) => candidate.contains(choice));
        if (!sectionCandidates.length) continue;
        const value = score(from, candidate.getBoundingClientRect(), direction);
        if (value !== null && value < nextScore) {
          nextScore = value;
          nextSection = candidate;
        }
      }
      if (nextSection) {
        // Crossing a declared section boundary enters that section at its representative control. Geometry is
        // deliberately only section-local: otherwise a left-aligned Continue Watching link can land on a later
        // reaction merely because that reaction happens to share its x coordinate, skipping the primary Resume.
        return firstChoice(nextSection, candidates);
      }
    }
    // A page-level navigation bar sits outside the content sections it opens. Enter the nearest declared section
    // at that section's representative control instead of letting one shared x-coordinate skip an earlier group
    // (for example Settings -> Content while the visible Playback group is first). The page declares its groups;
    // the navigation engine remains independent of their names and controls.
    if (!section && direction === 'down' && current.closest('nav[aria-label="Main navigation"]')) {
      const from = current.getBoundingClientRect();
      let entry: HTMLElement | undefined;
      let entryScore = Infinity;
      for (const candidate of root.querySelectorAll<HTMLElement>('[data-spatial-section]')) {
        const sectionCandidates = candidates.filter((choice) => candidate.contains(choice));
        if (!sectionCandidates.length) continue;
        const value = score(from, candidate.getBoundingClientRect(), direction);
        if (value !== null && value < entryScore) {
          entryScore = value;
          entry = candidate;
        }
      }
      if (entry) return firstChoice(entry, candidates);
    }
  }

  // A tab owns its panel only at the panel's leading edge. Semantic rows inside that panel get the first chance
  // above, so Up walks episode 3 -> 2 -> 1 before episode 1 exits to the selected season. This applies equally to
  // any later tab panel containing a declared vertical list; it is not an episode-number exception.
  if (direction === 'up') {
    const panel = current.closest<HTMLElement>('[role="tabpanel"][id]');
    const selected = panel
      ? root.querySelector<HTMLElement>(
          `[role="tab"][aria-selected="true"][aria-controls="${CSS.escape(panel.id)}"]`,
        )
      : null;
    if (selected && candidates.includes(selected)) return selected;
  }

  // An action painted over a primary surface is spatially above it even when both occupy the same rectangle.
  // The relationship is declared by the component, so the engine need not know what kind of card it contains.
  const overlay = current.closest<HTMLElement>('[data-spatial-overlay]');
  const actions = overlay?.querySelector<HTMLElement>('[data-spatial-overlay-actions]');
  if (overlay && actions) {
    const action = firstChoice(actions, candidates);
    const primary = Array.from(overlay.querySelectorAll<HTMLElement>(FOCUSABLE)).find(
      (choice) => candidates.includes(choice) && !actions.contains(choice),
    );
    if (direction === 'up' && !actions.contains(current) && action) return action;
    if (direction === 'down' && actions.contains(current) && primary) return primary;
  }

  // A side rail and result grid are separate focus regions. Geometry remains in charge inside the grid; only its
  // left edge crosses back to the selected rail choice, and Right from the rail enters the first result.
  const split = current.closest<HTMLElement>('[data-spatial-split]');
  const rail = split?.querySelector<HTMLElement>('[data-spatial-rail]');
  const grid = split?.querySelector<HTMLElement>('[data-spatial-grid]');
  if (split && rail && grid) {
    if (direction === 'right' && rail.contains(current)) return firstChoice(grid, candidates);
    if (direction === 'left' && grid.contains(current)) {
      const from = current.getBoundingClientRect();
      const hasGridChoiceToLeft = candidates.some((choice) => {
        if (choice === current || !grid.contains(choice)) return false;
        const other = choice.getBoundingClientRect();
        return (
          other.left + other.width / 2 < from.left + from.width / 2 - 2 &&
          Math.min(from.bottom, other.bottom) > Math.max(from.top, other.top)
        );
      });
      if (!hasGridChoiceToLeft) return firstChoice(rail, candidates);
    }
  }
  return undefined;
}

/** Prefer the same row/column. Horizontal input is row-local: crossing sections is an explicit Up/Down move. */
function score(from: DOMRect, to: DOMRect, direction: Direction): number | null {
  const dx = to.left + to.width / 2 - from.left - from.width / 2;
  const dy = to.top + to.height / 2 - from.top - from.height / 2;
  const primary =
    direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy;
  if (primary <= 2) return null;
  const secondary = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
  const overlap =
    direction === 'left' || direction === 'right'
      ? Math.max(0, Math.min(from.bottom, to.bottom) - Math.max(from.top, to.top))
      : Math.max(0, Math.min(from.right, to.right) - Math.max(from.left, to.left));
  // At the end of an action row, a distant card in the next section can still sit slightly to the right. Treating
  // that diagonal as Right made Share jump into Cast, and caused the same leak between unrelated shelves. Vertical
  // movement remains deliberately permissive because differently aligned rows still need to connect.
  if ((direction === 'left' || direction === 'right') && overlap <= 0) return null;
  return primary + secondary * (overlap > 0 ? 2.2 : 4.5);
}

function geometricDestination(
  current: HTMLElement,
  direction: Direction,
  candidates: HTMLElement[],
): HTMLElement | undefined {
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
  return winner;
}

export function moveFocus(
  direction: Direction,
  include: (candidate: HTMLElement) => boolean = () => true,
  behavior: ScrollBehavior = matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth',
): boolean {
  const current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const allCandidates = focusables();
  // Progressive enhancement only: low-priority links remain in the document's native Tab order and keep all
  // pointer/screen-reader semantics, but they do not interrupt the short directional path between primary controls.
  const candidates = allCandidates.filter(
    (element) => !element.hasAttribute('data-spatial-skip') && include(element),
  );
  if (!candidates.length) return false;
  if (!current || !visible(current) || !allCandidates.includes(current)) {
    const first = candidates[0]!;
    first.focus({ preventScroll: true });
    first.scrollIntoView({ block: 'center', inline: 'center' });
    return true;
  }
  // ARIA ownership outranks visual proximity. For example, Up from an episode in a season tab panel returns to
  // the selected season rather than a title-level action which happens to be geometrically nearer. Keeping this
  // in the shared engine gives the browser keyboard enhancement and every TV adapter the same rule.
  const semantic = semanticDestination(current, direction, candidates);
  if (semantic && candidates.includes(semantic)) {
    semantic.focus({ preventScroll: true });
    semantic.scrollIntoView({ behavior, block: 'nearest', inline: 'nearest' });
    return true;
  }
  // Cards in a declared grid are one navigation surface. A fixed Back button can be geometrically closer than
  // the preceding row after scrolling, but it must not win while there is still a card in the requested direction.
  const grid = current.closest<HTMLElement>('[data-spatial-grid]');
  const gridCandidates = grid ? candidates.filter((candidate) => grid.contains(candidate)) : [];
  const winner =
    geometricDestination(current, direction, gridCandidates) ??
    geometricDestination(current, direction, candidates);
  if (!winner) return false;
  winner.focus({ preventScroll: true });
  winner.scrollIntoView({ behavior, block: 'nearest', inline: 'nearest' });
  return true;
}
