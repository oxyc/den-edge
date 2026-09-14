import { LibraryLog } from './log';
import type { Title, Shape } from './library';
import { forgetLibraryCredential } from './relayFetch';
import { fetchRoutes, type Routes } from './routes';

/** Cached pages share one log and revision, so a detail action updates the retained Home immediately. */
export class LibrarySession {
  displays = $state<Title[]>([]);
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Consumers assign complete shape snapshots to state; they never mutate this map in place.
  shapes = $state(new Map<string, Shape>());
  revision = $state(0);
  settingsRevision = $state(0);
  log = $state<LibraryLog | null | undefined>(undefined);
  readonly opened: Promise<LibraryLog | null>;
  private refreshing?: Promise<void>;
  /** Asked as the session starts, beside the library: discovery needs them, and they don't need the library. */
  private early?: Promise<Routes> = fetchRoutes();
  /**
   * A session with no key never opens a library: `log` is null from the outset and stays there. That is the
   * guest — someone browsing without having paired — and it is the whole of the difference, because
   * `routes()` is keyless and still answers, which is what service discovery needs.
   */
  constructor(
    private readonly key: string | null,
    /** `key` is this browser's own library (`LibraryLog.openLocal`), kept here with no TV behind it. */
    readonly local = false,
  ) {
    this.opened = this.refresh().then(() => this.log ?? null);
  }

  /** den-edge's routes: the ones asked at the start the first time, a fresh ask after that. */
  routes(): Promise<Routes> {
    const early = this.early;
    this.early = undefined;
    return early ?? fetchRoutes();
  }

  /** One refresh owner for every route, including Settings. Failed opens are retryable. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        // No key, no library — and nothing to retry, unlike an open that failed.
        if (this.key === null) {
          // A browser that just gave up its key is a visitor again, and must stop claiming a membership.
          forgetLibraryCredential();
          this.log = null;
          return;
        }
        if (this.local) {
          // Its own library is still a visitor's: it proves no membership of anything on den-edge.
          forgetLibraryCredential();
          if (!this.log) {
            this.log = await LibraryLog.openLocal(this.key);
            if (this.log) this.changed(true);
          }
          return;
        }
        if (!this.log) {
          this.log = await LibraryLog.open(this.key);
          if (this.log) this.changed(true);
          // The copy kept from the last visit shows at once; what changed since follows it.
          if (!this.log?.fromCache) return;
        }
        const settings = () =>
          JSON.stringify(['keys', 'plugins', 'prefs'].map((name) => this.log?.settings(name)));
        const before = settings();
        if (await this.log.refresh()) this.changed(before !== settings());
      } catch {
        // Keep an existing log and its journal intact; an initial failure can open again next tick.
        if (!this.log) this.log = null;
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  start(onMoved: () => void): () => void {
    // Nothing to poll for, and no library that could move out from under this browser.
    if (this.key === null || this.local) return () => undefined;
    let disposed = false;
    const refresh = async () => {
      if (document.hidden || disposed) return;
      await this.refresh();
      if (!disposed && this.log?.moved) onMoved();
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }
  changed(settings = false) {
    this.revision++;
    if (settings) this.settingsRevision++;
  }
}
