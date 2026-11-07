// Session-scoped provider discovery. Durable inputs and retained results belong to LibraryModel; this class only
// owns the live probes and the render-facing addresses they discover.

import { availability } from './availability.svelte';
import { readDebridState, type DebridState } from './debridStatus';
import { discoverServices } from './discoverServices';
import { guestGrants } from './grants.svelte';
import { sharedInstallOf } from './grants';
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

/** A retained playback install is usable only while the current authority still lists its manifest. */
function retainsScout(install: string, plugins: readonly string[]): boolean {
  const shared = sharedInstallOf(install);
  if (shared) return plugins.some((plugin) => sharedInstallOf(plugin)?.install === shared.install);
  const manifest = `${install.replace(/\/+$/, '')}/manifest.json`;
  try {
    const expected = new URL(manifest, globalThis.location?.href).href;
    return plugins.some((plugin) => new URL(plugin, globalThis.location?.href).href === expected);
  } catch {
    return false;
  }
}

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
  /** The debrid service behind the playback addon, read once per live discovery; null when Hearth doesn't say. */
  debrid = $state<DebridState | null>(null);

  #for?: string;
  #stop?: () => void;
  #keep?: ReturnType<typeof setTimeout>;
  #grantsReady = false;
  #grantsRefreshing = false;
  #pendingConfigure?: [library: boolean, plugins: readonly string[], remux: string | null];
  #stopped = false;
  #foregroundReady = false;
  #atlasGeneration = 0;
  readonly #model: LibraryModel | null;

  constructor(
    model: LibraryModel | null,
    private readonly content: ContentServiceClientPort,
    private readonly fetchRouteTable: () => Promise<Routes> = fetchRoutes,
  ) {
    this.#model = model;
  }

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
    if (this.#stopped) return;
    const wanted: [boolean, readonly string[], string | null] = [
      this.#model !== null,
      runtime?.pluginManifestUrls ?? [],
      runtime?.privateRemuxUrl ?? null,
    ];
    this.#pendingConfigure = wanted;
    if (this.#grantsReady) return this.#configure(...wanted);
    if (this.#grantsRefreshing) return;
    this.#grantsRefreshing = true;
    void guestGrants.refresh().then(
      () => {
        this.#grantsRefreshing = false;
        this.#grantsReady = true;
        if (!this.#stopped && this.#pendingConfigure) this.#configure(...this.#pendingConfigure);
      },
      () => {
        this.#grantsRefreshing = false;
        // A cached grant is not current authority after a failed refresh. Continue with member plugins only; a later
        // configure retries the refresh and can visibly recover without ever publishing the unverified guest Scout.
        if (!this.#stopped && this.#pendingConfigure)
          this.#configure(...this.#pendingConfigure, []);
      },
    );
  }

  #configure(
    library: boolean,
    libraryPlugins: readonly string[],
    remux: string | null,
    shared: readonly string[] = guestGrants.pluginUrls(),
  ): void {
    if (this.#for === undefined && !this.#foregroundReady) availability.connect(null, this.content);
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
    if (this.scout && !retainsScout(this.scout.install, plugins)) {
      this.scout = null;
      this.debrid = null;
      if (this.#foregroundReady) availability.connect(null, this.content);
    }
    let current = true;
    // Invalidate acknowledgements owned by a prior discovery run before any of its promises can publish.
    this.#atlasGeneration++;
    this.atlas = null;
    this.atlasReady = false;
    this.#stop = () => {
      current = false;
    };

    let live = false;
    // A live atlas answer, as opposed to none: atlas unreachable says nothing about whether it is there, so the
    // retained address stands until atlas itself answers, and what this browser kept of it is shown (`atlasKept`).
    let liveAtlas = false;
    if (first && this.#model)
      void this.#model
        .retainedServices()
        .then((saved) => {
          if (!current || !saved) return;
          if (!liveAtlas) this.#configureAtlas(saved.atlas, () => current);
          if (live) return;
          this.routes = Object.fromEntries(
            Object.entries(saved.routes).map(([name, entries]) => [
              name,
              entries.map((entry) => ({ ...entry })),
            ]),
          );
          // A playback route is a live runtime capability, never a durable retained hint.
          this.scout =
            saved.scout && retainsScout(saved.scout.install, plugins)
              ? { install: saved.scout.install, base: saved.scout.base }
              : null;
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
                if (!current) return;
                this.scout = found;
                if (this.#foregroundReady) availability.connect(found, this.content);
                if (found)
                  void readDebridState(found).then((state) => {
                    if (current && this.scout === found) this.debrid = state;
                  });
                this.#settled();
              },
              remux: (found: string | null) => {
                if (!current) return;
                this.remux = found;
                this.remuxAway = found === null;
                this.remuxBlocked = false;
                if (found === null)
                  void localNetworkRefused().then((refused) => {
                    if (current) this.remuxBlocked = refused;
                  });
                if (found && this.#model)
                  void this.#model.rememberPrivateRemux(found).catch(() => {
                    // Rediscovered next visit; this background convenience is never user-blocking.
                  });
                this.#settled();
              },
            }
          : {}),
        atlas: (found) => {
          if (!current) return;
          if (found === undefined) return;
          liveAtlas = true;
          this.#configureAtlas(found?.base ?? null, () => current);
        },
        reel: (found) => {
          if (!current) return;
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
    this.#stopped = true;
    this.#stop?.();
    this.#atlasGeneration++;
    clearTimeout(this.#keep);
  }

  #settled(): void {
    if (!this.#model) return;
    clearTimeout(this.#keep);
    this.#keep = setTimeout(() => {
      if (!Object.keys(this.routes).length) return;
      const retainedScout = this.scout
        ? { install: this.scout.install, base: this.scout.base }
        : null;
      void this.#model
        ?.retainServices({
          routes: this.routes,
          scout: retainedScout,
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
