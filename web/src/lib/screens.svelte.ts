// The screens Home doesn't draw, each in its own chunk: a first visit downloads and runs only what paints Home. Each
// loads when a route asks for it, and all of them once Home has painted, so opening one rarely waits.

import type { Component } from 'svelte';

/** A component loaded on first use and kept, so every page that shows it after that renders it at once. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any component, whose own props type flows through
function lazy<C extends Component<any, any, any>>(load: () => Promise<{ default: C }>) {
  let component = $state.raw<C | null>(null);
  let loading: Promise<void> | undefined;
  return {
    get current() {
      return component;
    },
    load(): Promise<void> {
      loading ??= load().then(
        (module) => {
          component = module.default;
        },
        (error: unknown) => {
          loading = undefined;
          console.warn('den: a screen could not be loaded', error);
        },
      );
      return loading;
    },
  };
}

export const DetailScreen = lazy(() => import('../components/Detail.svelte'));
export const PersonScreen = lazy(() => import('../components/Person.svelte'));
export const SearchScreen = lazy(() => import('../components/Search.svelte'));
export const PlayerScreen = lazy(() => import('../components/Player.svelte'));
export const SettingsScreen = lazy(() => import('../Settings.svelte'));
export const LinkScreen = lazy(() => import('../LinkTV.svelte'));

/** Every screen a paired page can open, fetched while the browser is idle after Home has painted. */
export function preloadScreens(): void {
  const load = () => {
    if (!navigator.onLine) return;
    for (const screen of [DetailScreen, PersonScreen, SearchScreen, PlayerScreen, SettingsScreen])
      void screen.load();
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(load, { timeout: 4000 });
  else setTimeout(load, 1500);
}
