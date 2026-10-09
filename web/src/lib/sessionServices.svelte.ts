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
import type { ContentServiceClientPort } from './contentServiceClient';

type Runtime = Immutable<RuntimeDiscoveryView>;

const inputs = (library: boolean, plugins: readonly string[], remux: string | null) =>
  JSON.stringify([library, plugins, remux]);

export class SessionServices {
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
  #atlasGeneration = 0;

  constructor(
    private readonly model: LibraryModel | null,
    private readonly content: ContentServiceClientPort,
    private readonly fetchRouteTable: () => Promise<Routes> = fetchRoutes,
  ) {}

  /**
   * Publish an Atlas address only after this exact discovery generation is usable by the content Worker. An older
   * retained hint or stopped discovery run can finish later, but can never replace the current answer.
   */
  #configureAtlas(base: string | null, current: () => boolean): void {
    if (this.atlasReady && this.atlas === base) {
      this.#settled();
      return;
    }
    const generation = ++this.#atlasGeneration;
    this.atlas = null;
    this.atlasReady = false;
    void this.content.query({ kind: 'sources.configure', atlas: base }).then(
      () => {
        if (!current() || generation !== this.#atlasGeneration) return;
        // These assignments publish in one Svelte update: no consumer can observe an address the Worker has not
        // acknowledged, nor a ready flag paired with a stale address.
        this.atlas = base;
        this.atlasReady = true;
        this.#settled();
      },
      (error: unknown) => {
        if (!current() || generation !== this.#atlasGeneration) return;
        console.warn('den: content source configuration failed', error);
      },
    );
  }

  /** Reconfigure from the authority's deliberately narrow discovery view. */
  configure(runtime: Runtime | undefined): void {
    this.#configure(
      this.model !== null,
      runtime?.pluginManifestUrls ?? [],
      runtime?.privateRemuxUrl ?? null,
    );
  }

  #configure(library: boolean, libraryPlugins: readonly string[], remux: string | null): void {
    if (this.#for === undefined && !this.#foregroundReady) availability.connect(null, this.content);
    if (!this.#grants) {
      this.#grants = true;
      void guestGrants.refresh();
    }
    const shared = guestGrants.pluginUrls();
    const plugins = [...libraryPlugins, ...shared].filter(
      (plugin, index, all) => all.indexOf(plugin) === index,
    );
    const wanted = inputs(library, plugins, remux);
    if (wanted === this.#for) return;
    const first = this.#for === undefined;
    this.#for = wanted;
    clearTimeout(this.#keep);
    this.#keep = undefined;
    this.#stop?.();
    if (JSON.stringify(this.plugins) !== JSON.stringify(plugins)) this.plugins = plugins;
    let current = true;
    // Invalidate acknowledgements owned by a prior discovery run before any of its promises can publish.
    this.#atlasGeneration++;
    this.atlas = null;
    this.atlasReady = false;
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
          this.#configureAtlas(saved.atlas, () => current);
          this.reel = saved.reel;
          this.remux = saved.remux;
          if (this.#foregroundReady) availability.connect(this.scout, this.content);
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
                if (this.#foregroundReady) availability.connect(found, this.content);
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
          this.#configureAtlas(found?.base ?? null, () => current);
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
    availability.connect(this.scout, this.content);
  }

  stop(): void {
    this.#stop?.();
    this.#atlasGeneration++;
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
