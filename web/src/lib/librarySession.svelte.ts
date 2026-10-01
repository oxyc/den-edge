import { LIVE_PULL_MS } from './livePosition';
import { browserClock } from './clock';
import { LibraryLog } from './log';
import { deliverSimkl } from './simklDelivery';
import { switchLibraryToV4, upgradeLibrary } from './libraryUpgrade';
import type { Title, Shape } from './library';
import { forgetLibraryCredential } from './relayFetch';
import { fetchRoutes, type Routes } from './routes';
import { SessionServices } from './sessionServices.svelte';

/** Cached pages share one log and revision, so a detail action updates the retained Home immediately. */
export class LibrarySession {
  displays = $state<Title[]>([]);
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Consumers assign complete shape snapshots to state; they never mutate this map in place.
  shapes = $state(new Map<string, Shape>());
  revision = $state(0);
  settingsRevision = $state(0);
  /** Something in the library is playing somewhere (`livePosition`): pull faster, so a pause shows soon. */
  live = false;
  log = $state<LibraryLog | null | undefined>(undefined);
  /** A passing message about the library ("Library updated to v4"), shown for a few seconds (`notify`). */
  toast = $state<string | null>(null);
  /** What keeps the library from being written, while it does (`libraryAlert`). */
  alert = $state<string | null>(null);
  private toastTimer?: ReturnType<typeof setTimeout>;
  readonly opened: Promise<LibraryLog | null>;
  private refreshing?: Promise<void>;
  private readonly device = browserClock().device;
  /** Asked as the session starts, beside the library: discovery needs them, and they don't need the library. */
  private early?: Promise<Routes> = fetchRoutes();
  /** Where the library's services answer, found once for every page (`sessionServices.svelte.ts`). */
  readonly services = new SessionServices(
    () => this.routes(),
    () => this.changed(true),
  );
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
          if (this.log && (await upgradeLibrary(this.log, true))) this.changed(true);
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
        if (await upgradeLibrary(this.log, false)) this.changed(true);
        if (await switchLibraryToV4(this.log)) {
          this.changed(true);
          this.notify('Library updated to v4');
        }
        if (await this.log.compact()) this.changed(true);
        if (
          this.log.wireMinimum >= 3 &&
          !this.log.readOnly &&
          (await deliverSimkl(this.log, this.device))
        )
          this.changed(true);
      } catch (error) {
        // Keep an existing log and its journal intact; an initial failure can open again next tick.
        console.warn('den: the library could not be refreshed', error);
        if (!this.log) this.log = null;
      } finally {
        this.alert = this.log ? libraryAlert(this.log) : null;
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await refresh();
      if (!disposed) timer = setTimeout(() => void tick(), this.live ? LIVE_PULL_MS : 30_000);
    };
    void tick();
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }
  changed(settings = false) {
    this.revision++;
    if (settings) this.settingsRevision++;
  }

  /** A passing message, cleared after a few seconds. */
  notify(message: string) {
    this.toast = message;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toast = null), TOAST_MS);
  }
}

const TOAST_MS = 6000;

/** What stops this browser writing the library, said the way the spec words it (library v4 §4, §10). */
export function libraryAlert(log: LibraryLog): string | null {
  if (log.upgradeRequired !== null) return 'Library update required';
  if (log.predatesV3) return 'Library backup predates v3';
  if (log.switchFailure) return `Library update failed: ${log.switchFailure}`;
  return null;
}
