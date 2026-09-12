import { LibraryLog } from './log';
import type { Title, Shape } from './library';

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
  constructor(private readonly key: string) {
    this.opened = this.refresh().then(() => this.log ?? null);
  }

  /** One refresh owner for every route, including Settings. Failed opens are retryable. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        if (!this.log) {
          this.log = await LibraryLog.open(this.key);
          if (this.log) this.changed(true);
          return;
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
