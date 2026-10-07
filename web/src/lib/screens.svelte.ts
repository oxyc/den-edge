// The screens Home doesn't draw, each in its own chunk: a first visit downloads and runs only what paints Home. Each
// loads when a route asks for it, and all of them once Home has painted, so opening one rarely waits.

import type { Component } from 'svelte';

/** A component loaded on first use and kept, so every page that shows it after that renders it at once. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any component, whose own props type flows through
export function lazy<C extends Component<any, any, any>>(load: () => Promise<{ default: C }>) {
  let component = $state.raw<C | null>(null);
  let failed = $state(false);
  let loading: Promise<void> | undefined;
  return {
    get current() {
      return component;
    },
    /** The last try failed and none is running: the page says so and offers another (`ScreenLoading`). */
    get failed() {
      return failed;
    },
    load(): Promise<void> {
      failed = false;
      loading ??= load().then(
        (module) => {
          component = module.default;
        },
        (error: unknown) => {
          loading = undefined;
          failed = true;
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
export const PeopleScreen = lazy(() => import('../components/People.svelte'));
export const PlayerScreen = lazy(() => import('../components/Player.svelte'));
export const ServiceScreen = lazy(() => import('../components/ServicePage.svelte'));
export const SettingsScreen = lazy(() => import('../Settings.svelte'));
export const LinkScreen = lazy(() => import('../LinkTV.svelte'));
export const WatchlistScreen = lazy(() => import('../components/WatchlistPage.svelte'));
/** Asked only by a page that carries their question: an invite link, or an assistant's request to connect. */
export const InviteDialogScreen = lazy(() => import('../components/InviteDialog.svelte'));
export const ConnectDialogScreen = lazy(() => import('../components/ConnectDialog.svelte'));

/** Home's bounded speculative tail. Everything absent here is loaded only by route or pointer intent. */
export const HOME_SCREEN_PRELOADS = [[DetailScreen, SearchScreen], [PersonScreen]] as const;

let preloading = false;

type NetworkHint = { saveData?: boolean; effectiveType?: string };
type LoadableScreen = { load(): Promise<void> };
type IdleScheduler = (task: () => void) => void;

/** Slow or metered links get chunks from intent only; speculative work must not compete with the page. */
export function permitsScreenPreload(connection?: NetworkHint): boolean {
  if (connection?.saveData) return false;
  return !['slow-2g', '2g', '3g'].includes(connection?.effectiveType ?? '');
}

/**
 * Load each batch in a separate idle turn, and do not admit the next until the current imports have settled.
 * This keeps a group of dynamic imports from becoming one network/parse burst merely because Home became idle.
 */
export function preloadInIdle(
  batches: readonly (readonly LoadableScreen[])[],
  schedule: IdleScheduler,
): void {
  let nextBatch = 0;
  const next = () => {
    const batch = batches[nextBatch++];
    if (!batch) return;
    schedule(() => {
      void Promise.allSettled(batch.map((screen) => screen.load())).then(next);
    });
  };
  next();
}

/** Common next screens, fetched in small idle slices on a fast connection after the hero has painted. */
export function preloadScreens(): void {
  if (preloading) return;
  const connection = (navigator as Navigator & { connection?: NetworkHint }).connection;
  if (!permitsScreenPreload(connection)) return;
  preloading = true;
  const idle: IdleScheduler = (task) => {
    const schedule = () => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(task, { timeout: 2500 });
      else setTimeout(task, 1000);
    };
    // Offline the chunks are out of reach; they are fetched when the browser is back rather than never.
    if (navigator.onLine) schedule();
    else window.addEventListener('online', schedule, { once: true });
  };
  // Detail and Search are the common next taps. Person follows in its own idle slice. Large or uncommon routes
  // (Settings, Player, Service and Watchlist) stay intent-only: their route effects above load them when asked.
  preloadInIdle(HOME_SCREEN_PRELOADS, idle);
}
