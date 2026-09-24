// Where this library's services answer — den-edge's routes, scout, atlas, reel and den-remux — found once for the
// session rather than once per page. Every kept page is its own `Library`, and each used to run this discovery
// itself as it mounted: a title page's trailer, related rows and Play here waited on `/routes`, the manifest probes
// and `findRemux` (3 s per unreachable address) all over again, and every kept page repeated it on a settings change.

import { availability } from './availability.svelte';
import { browserClock } from './clock';
import { discoverServices } from './discoverServices';
import { guestGrants } from './grants.svelte';
import type { LibraryLog } from './log';
import { readPlugins } from './prefs';
import { ADDRESSES, ahead, healed, readPrivateAddresses } from './privateAddresses';
import { localNetworkRefused } from './remux';
import type { Routes } from './routes';
import type { Addon } from './scout';
import { ensureSyncPolicy } from './syncLoader';
import { tmdbKeyOf } from './tmdb';

/** Where this browser keeps what discovery found (`LibraryLog.keep`). */
const SERVICES = 'services.v1';
/** What discovery reads, so asking again with the same inputs starts nothing. */
const inputs = (library: boolean, tmdbKey: string, plugins: string[], remux: string | null) =>
  JSON.stringify([library, tmdbKey, plugins, remux]);

type Kept = {
  routes: Routes;
  scout: Addon | null;
  atlas: string | null;
  reel: string | null;
  remux: string | null;
};

export class SessionServices {
  /** The TMDB key the library shares (`set:keys`), or den-edge's for a device with none (`tmdbKeyOf`). */
  tmdbKey = $state('');
  /** The library's addons (`set:plugins`) and those shared with this browser. */
  plugins = $state.raw<string[]>([]);
  scout = $state.raw<Addon | null>(null);
  /** Where this page reaches atlas, search's indexes; null where it can't. */
  atlas = $state<string | null>(null);
  /** Distinguishes "Atlas discovery still running" from its settled no-Atlas answer. */
  atlasReady = $state(false);
  /** Where this page reaches reel, the billboard's trailers; null where it can't. */
  reel = $state<string | null>(null);
  /** den-edge's routes table: which installs are Den's own, and where den-remux answers (den-spec routes-v1). */
  routes = $state.raw<Routes>({});
  /** Where den-remux answers for this browser (`findRemux`); null where no route reaches it. */
  remux = $state<string | null>(null);
  /** Discovery answered, and no route reaches den-remux from here: away from home and off the tailnet. */
  remuxAway = $state(false);
  /** …and this browser refused the home network itself (`localNetworkRefused`), which is a different thing to say. */
  remuxBlocked = $state(false);

  /** What the running discovery was started for, so asking again with the same settings starts nothing. */
  #for?: string;
  #stop?: () => void;
  #keep?: ReturnType<typeof setTimeout>;
  #grants = false;
  readonly #clock = browserClock();

  constructor(
    /** den-edge's routes, asked as the session starts (`LibrarySession.routes`). */
    private readonly fetchRoutes: () => Promise<Routes>,
    /** A setting was written: the session's revision moves. */
    private readonly changed: () => void,
  ) {}

  /**
   * Discover for the library as it is now: `opened` is null for a guest, who still has atlas and reel on this
   * origin. Asked by every page on each settings change; only a change in what discovery reads starts it again,
   * and what the last run found stays until the new one answers, so nothing blanks while it asks.
   */
  configure(opened: LibraryLog | null): void {
    if (!this.#grants) {
      this.#grants = true;
      // A grant's name, end date or ended state as den-edge holds it now.
      void guestGrants.refresh();
    }
    // The addons shared with this browser join the library's own for lookups; nothing writes them back to it.
    const shared = guestGrants.pluginUrls();
    const tmdbKey = tmdbKeyOf(opened?.settings('keys'));
    const plugins = [...(opened ? readPlugins(opened.settings('plugins')) : []), ...shared];
    const kept = readPrivateAddresses(opened?.settings(ADDRESSES));
    const wanted = inputs(opened !== null, tmdbKey, plugins, kept.remux ?? null);
    if (wanted === this.#for) return;
    const first = this.#for === undefined;
    this.#for = wanted;
    this.#stop?.();
    this.tmdbKey = tmdbKey;
    if (JSON.stringify(this.plugins) !== JSON.stringify(plugins)) this.plugins = plugins;
    let current = true;
    this.#stop = () => {
      current = false;
    };
    // Where the last visit found the addons, used until this visit's discovery answers. A guest keeps nothing
    // between visits — what is kept lives in the library — so there is nothing to restore.
    let live = false;
    if (first && opened)
      void opened.kept<Kept>(SERVICES).then((saved) => {
        if (!current || live || !saved) return;
        ({
          routes: this.routes,
          scout: this.scout,
          atlas: this.atlas,
          reel: this.reel,
          remux: this.remux,
        } = saved);
        availability.connect(saved.scout, tmdbKey);
      });
    void (async () => {
      const foundRoutes = await this.fetchRoutes();
      if (!current) return;
      live = true;
      this.routes = foundRoutes;
      // The household's own tailnet address for den-remux, tried ahead of the table's entries: on the public name
      // the table names none at all, and this is the only thing that reaches it.
      const forDiscovery = { ...foundRoutes, remux: ahead(kept.remux, foundRoutes.remux) };
      const stop = discoverServices(plugins, forDiscovery, {
        // A guest holding no shared grant is handed neither publisher, so those probes are never issued and the
        // playback services cannot be discovered at all. Structural, rather than a callback someone has to remember
        // to leave out. A guest holding a grant plays through the shared scout and den-remux, so it is handed both.
        ...(opened || shared.length > 0
          ? {
              scout: (found: Addon | null) => {
                this.scout = found;
                availability.connect(found, tmdbKey);
                this.#settled(opened);
              },
              remux: (found: string | null) => {
                this.remux = found;
                this.remuxAway = found === null;
                // Asked only once nothing answered, and never waited on: what is said under the actions is
                // corrected when the browser replies, rather than holding the page for a permission.
                this.remuxBlocked = false;
                if (found === null) {
                  void localNetworkRefused().then((refused) => {
                    if (current) this.remuxBlocked = refused;
                  });
                }
                // Where it answered, kept for the visit that will be shown no private address. That write is a
                // settings change, and the address it keeps is one this run already reached: not a reason to
                // discover again, so the run counts as started for it.
                void this.#remember(opened, 'remux', found).then((stored) => {
                  if (stored === undefined) return;
                  if (current) this.#for = inputs(opened !== null, tmdbKey, plugins, stored);
                  this.changed();
                });
                this.#settled(opened);
              },
            }
          : {}),
        atlas: (found) => {
          this.atlas = found?.base ?? null;
          this.atlasReady = true;
          this.#settled(opened);
        },
        reel: (found) => {
          this.reel = found?.base ?? null;
          this.#settled(opened);
        },
      });
      this.#stop = () => {
        current = false;
        stop();
      };
    })();
  }

  /** Stop publishing: the session is over. */
  stop(): void {
    this.#stop?.();
    clearTimeout(this.#keep);
  }

  /** What discovery found, kept for the next visit once it has settled for a moment. */
  #settled(opened: LibraryLog | null): void {
    if (!opened) return;
    clearTimeout(this.#keep);
    this.#keep = setTimeout(() => {
      const found: Kept = {
        routes: this.routes,
        scout: this.scout,
        atlas: this.atlas,
        reel: this.reel,
        remux: this.remux,
      };
      if (!Object.keys(found.routes).length) return;
      void opened
        .keep(SERVICES, found)
        .catch((error: unknown) => console.warn('den: Home could not be kept', error));
    }, 1000);
  }

  /**
   * Keep where a service actually answered, when the library doesn't already say so.
   *
   * den-edge's public name serves a table naming nothing private, so a viewer on Tailscale is told nothing about
   * den-remux even though it is a hostname away. The library is sealed and can hold what the table won't publish —
   * but only what a device has reached for itself, and only from a face that could see it.
   *
   * Quiet on purpose. Nobody asked for this write, and a household that cannot reach its own library has a larger
   * problem than an address the next visit will discover again. The address as kept, once it was written.
   */
  async #remember(
    opened: LibraryLog | null,
    service: string,
    reached: string | null,
  ): Promise<string | null | undefined> {
    if (!opened) return;
    const change = healed(readPrivateAddresses(opened.settings(ADDRESSES)), service, reached);
    if (!change) return;
    try {
      await ensureSyncPolicy();
      const base = opened.settings(ADDRESSES) ?? {
        kind: 'set' as const,
        schema: 2,
        name: ADDRESSES,
        values: {},
      };
      this.#clock.see(opened.newestStamp());
      const at = this.#clock.issue();
      const values = { ...base.values };
      for (const [key, value] of Object.entries(change)) values[key] = { value, at };
      if (await opened.write({ ...base, values }))
        return readPrivateAddresses(opened.settings(ADDRESSES))[service] ?? null;
    } catch {
      // Rediscovered next visit; not worth a word to someone who asked for none of it.
    }
  }
}
