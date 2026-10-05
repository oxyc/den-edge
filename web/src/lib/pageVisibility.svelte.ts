import { getContext } from 'svelte';

export const PAGE_VISIBILITY = Symbol('route page visibility');

export interface PageVisibility {
  active: boolean;
}

const alwaysVisible: PageVisibility = { active: true };

/** The retained route page containing this component, or visible for fixtures and standalone components. */
export function pageVisibility(): PageVisibility {
  return getContext<PageVisibility | undefined>(PAGE_VISIBILITY) ?? alwaysVisible;
}
