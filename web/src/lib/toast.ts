// The page toast (`LibrarySession.notify`), reached from components that have no `session` prop of their own —
// `TitleActions`, on the title page, and the poster menu (`titleActions.ts`) — by context rather than threading
// it through every intermediate component.

import { getContext, setContext } from 'svelte';

const TOAST = Symbol('toast');

export type Notify = (message: string, undo?: { label: string; run: () => void }) => void;

export function setToastContext(notify: Notify) {
  setContext(TOAST, notify);
}

export function toastContext(): Notify | undefined {
  return getContext(TOAST);
}
