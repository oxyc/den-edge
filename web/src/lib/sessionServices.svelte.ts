// Session-scoped provider discovery. Durable inputs and retained results belong to LibraryModel; this class only
// owns the live probes and the render-facing addresses they discover.

import { availability } from './availability.svelte';
import { discoverServices } from './discoverServices';
import { guestGrants } from './grants.svelte';
import type { Immutable, LibraryModel } from './libraryModel.svelte';
import type { RuntimeDiscoveryView } from './libraryServiceProtocol';
import { ahead } from './privateAddresses';
import { localNetworkRefused } from './remuxRoute';
import { fetchRoutes, type Routes } from './routes';
import type { Addon } from './scout';
import { yieldTask } from './taskYield';
import { TMDB_PROXY_KEY } from './tmdb';

type Runtime = Immutable<RuntimeDiscoveryView>;

const inputs = (
  library: boolean,
  tmdbKey: string,
  providerKeys: Runtime['providerKeys'],
  plugins: readonly string[],
  remux: string | null,
) => JSON.stringify([library, tmdbKey, providerKeys, plugins, remux]);

export class SessionServices {
  tmdbKey = $state(TMDB_PROXY_KEY);
  providerKeys = $state.raw<Partial<Record<keyof Runtime['providerKeys'], string>>>({});
  plugins = $state.raw<string[]>([]);
  scout = $state.raw<Addon | null>(null);
  atlas = $state<string | null>(null);
  atlasReady = $state(false);
  reel = $state<string | null>(null);
  routes = $state.raw<Routes>({});
  remux = $state<string | null>(null);
  remuxAway = $state(false);
  remuxBlocked = $state(false);

  #for?: string;
  #stop?: () => void;
  #keep?: ReturnType<typeof setTimeout>;
  #grants = false;
  #foregroundReady = false;

  constructor(
    private readonly model: LibraryModel | null,
    private readonly fetchRouteTable: () => Promise<Routes> = fetchRoutes,
  ) {}

  /** Reconfigure from the authority's deliberately narrow discovery view. */
  configure(runtime: Runtime | undefined): void {
    this.#configure(
      this.model !== null,
      runtime?.tmdbKey ?? TMDB_PROXY_KEY,
      runtime?.providerKeys ?? {},
      runtime?.pluginManifestUrls ?? [],
      runtime?.privateRemuxUrl ?? null,
    );
  }

  #configure(
    library: boolean,
    tmdbKey: string,
    providerKeys: Runtime['providerKeys'],
    libraryPlugins: readonly string[],
    remux: string | null,
  ): void {
    if (this.#for === undefined && !this.#foregroundReady) availability.connect(null, '');
    if (!this.#grants) {
      this.#grants = true;
      void guestGrants.refresh();
    }
    const shared = guestGrants.pluginUrls();
    const plugins = [...libraryPlugins, ...shared].filter(
      (plugin, index, all) => all.indexOf(plugin) === index,
    );
    const wanted = inputs(library, tmdbKey, providerKeys, plugins, remux);
    if (wanted === this.#for) return;
    const first = this.#for === undefined;
    this.#for = wanted;
    clearTimeout(this.#keep);
    this.#keep = undefined;
    this.#stop?.();
    this.tmdbKey = tmdbKey;
    this.providerKeys = { ...providerKeys };
    if (JSON.stringify(this.plugins) !== JSON.stringify(plugins)) this.plugins = plugins;
    let current = true;
    this.#stop = () => {
      current = false;
    };

    let live = false;
    if (first && this.model)
      void this.model
        .retainedServices()
        .then((saved) => {
          if (!current || live || !saved) return;
          this.routes = Object.fromEntries(
            Object.entries(saved.routes).map(([name, entries]) => [
              name,
              entries.map((entry) => ({ ...entry })),
            ]),
          );
          this.scout = saved.scout ? { ...saved.scout } : null;
          this.atlas = saved.atlas;
          this.reel = saved.reel;
          this.remux = saved.remux;
          if (this.#foregroundReady) availability.connect(this.scout, tmdbKey);
        })
        .catch(() => {
          // Retained discovery is only a first-paint hint; live discovery below remains authoritative.
        });

    void (async () => {
      const foundRoutes = await this.fetchRouteTable();
      if (!current) return;
      await yieldTask();
      if (!current) return;
      live = true;
      this.routes = foundRoutes;
      const forDiscovery = { ...foundRoutes, remux: ahead(remux ?? undefined, foundRoutes.remux) };
      const stop = discoverServices(plugins, forDiscovery, {
        ...(library || shared.length > 0
          ? {
              scout: (found: Addon | null) => {
                this.scout = found;
                if (this.#foregroundReady) availability.connect(found, tmdbKey);
                this.#settled();
              },
              remux: (found: string | null) => {
                this.remux = found;
                this.remuxAway = found === null;
                this.remuxBlocked = false;
                if (found === null)
                  void localNetworkRefused().then((refused) => {
                    if (current) this.remuxBlocked = refused;
                  });
                if (found && this.model)
                  void this.model.rememberPrivateRemux(found).catch(() => {
                    // Rediscovered next visit; this background convenience is never user-blocking.
                  });
                this.#settled();
              },
            }
          : {}),
        atlas: (found) => {
          this.atlas = found?.base ?? null;
          this.atlasReady = true;
          this.#settled();
        },
        reel: (found) => {
          this.reel = found?.base ?? null;
          this.#settled();
        },
      });
      this.#stop = () => {
        current = false;
        stop();
      };
    })().catch(() => {
      // Keep the last retained answer. A later runtime change starts a fresh discovery run.
    });
  }

  foregroundReady(): void {
    if (this.#foregroundReady) return;
    this.#foregroundReady = true;
    availability.connect(this.scout, this.tmdbKey);
  }

  stop(): void {
    this.#stop?.();
    clearTimeout(this.#keep);
  }

  #settled(): void {
    if (!this.model) return;
    clearTimeout(this.#keep);
    this.#keep = setTimeout(() => {
      if (!Object.keys(this.routes).length) return;
      void this.model
        ?.retainServices({
          routes: this.routes,
          scout: this.scout,
          atlas: this.atlas,
          reel: this.reel,
          remux: this.remux,
        })
        .catch((error: unknown) =>
          console.warn('den: provider discovery could not be retained', error),
        );
    }, 1_000);
  }
}
