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
import type { GrantRefreshOutcome } from './grants.svelte';

type Runtime = Immutable<RuntimeDiscoveryView>;
type Grants = {
  pluginUrls(): string[];
  refresh(): Promise<GrantRefreshOutcome>;
};

const inputs = (library: boolean, plugins: readonly string[], remux: string | null) =>
  JSON.stringify([library, plugins, remux]);
const GRANT_RETRY_MS = 5_000;
const ROUTE_RETRY_MS = [1_000, 5_000] as const;

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
  #grantsRefreshing = false;
  #verifiedGrantsFor?: string;
  #pendingConfigure?: [library: boolean, plugins: readonly string[], remux: string | null, string];
  #grantRetry?: ReturnType<typeof setTimeout>;
  #requestedFor?: string;
  #configureGeneration = 0;
  #stopped = false;
  #foregroundReady = false;
  #atlasGeneration = 0;
  readonly #model: LibraryModel | null;

  constructor(
    model: LibraryModel | null,
    private readonly content: ContentServiceClientPort,
    private readonly fetchRouteTable: () => Promise<Routes> = fetchRoutes,
    private readonly grants: Grants = guestGrants,
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
    // This read must stay synchronous: it is the Svelte dependency that re-runs the caller's real `$effect` when a
    // redeem, expiry, replacement, or A→B→A grant transition changes authority. Async refresh and discovery below
    // are fenced separately.
    const shared = this.grants.pluginUrls();
    const grantsFor = JSON.stringify(shared);
    const wanted: [boolean, readonly string[], string | null, string] = [
      this.#model !== null,
      runtime?.pluginManifestUrls ?? [],
      runtime?.privateRemuxUrl ?? null,
      grantsFor,
    ];
    const requestedFor = JSON.stringify(wanted);
    if (this.#requestedFor !== undefined && requestedFor !== this.#requestedFor) {
      this.#configureGeneration++;
      this.#invalidateDiscovery();
    }
    this.#requestedFor = requestedFor;
    this.#pendingConfigure = wanted;
    const visiblePlugins = [...wanted[1], ...shared];
    if (this.scout && !retainsScout(this.scout.install, visiblePlugins)) {
      this.scout = null;
      this.debrid = null;
      if (this.#foregroundReady) availability.connect(null, this.content);
    }
    if (this.#grantsRefreshing) return;
    if (this.#verifiedGrantsFor === grantsFor)
      return this.#configure(wanted[0], wanted[1], wanted[2], shared);
    this.#refreshGrants();
  }

  #refreshGrants(): void {
    if (this.#stopped || this.#grantsRefreshing || !this.#pendingConfigure) return;
    this.#grantsRefreshing = true;
    const generation = this.#configureGeneration;
    void this.grants.refresh().then(
      (outcome) => {
        this.#grantsRefreshing = false;
        if (this.#stopped || !this.#pendingConfigure) return;
        if (generation !== this.#configureGeneration) {
          this.#refreshGrants();
          return;
        }
        const [library, plugins, remux] = this.#pendingConfigure;
        if (outcome === 'verified') {
          clearTimeout(this.#grantRetry);
          this.#grantRetry = undefined;
          const refreshed = this.grants.pluginUrls();
          this.#verifiedGrantsFor = JSON.stringify(refreshed);
          this.#configure(library, plugins, remux, refreshed);
          return;
        }
        // Cached grants remain useful storage, but are not current authority until one refresh verifies them.
        this.#configure(library, plugins, remux, []);
        clearTimeout(this.#grantRetry);
        this.#grantRetry = setTimeout(() => {
          this.#grantRetry = undefined;
          this.#refreshGrants();
        }, GRANT_RETRY_MS);
      },
      () => {
        this.#grantsRefreshing = false;
        if (this.#stopped || !this.#pendingConfigure) return;
        if (generation !== this.#configureGeneration) {
          this.#refreshGrants();
          return;
        }
        const [library, plugins, remux] = this.#pendingConfigure;
        this.#configure(library, plugins, remux, []);
        clearTimeout(this.#grantRetry);
        this.#grantRetry = setTimeout(() => {
          this.#grantRetry = undefined;
          this.#refreshGrants();
        }, GRANT_RETRY_MS);
      },
    );
  }

  /** Stop and withdraw everything a previous authority's live discovery could publish. */
  #invalidateDiscovery(): void {
    this.#stop?.();
    this.#stop = undefined;
    // Force the replacement run without making it another "first" run: retained Atlas/Reel/Remux belong to the
    // authority just withdrawn and must not repaint while the replacement's live route table is pending.
    this.#for = 'invalidated';
    this.#atlasGeneration++;
    clearTimeout(this.#keep);
    this.#keep = undefined;
    this.scout = null;
    this.debrid = null;
    this.atlas = null;
    this.atlasReady = false;
    this.reel = null;
    this.remux = null;
    this.remuxAway = false;
    this.remuxBlocked = false;
    if (this.#foregroundReady) availability.connect(null, this.content);
  }

  #configure(
    library: boolean,
    libraryPlugins: readonly string[],
    remux: string | null,
    shared: readonly string[] = this.grants.pluginUrls(),
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
    let routeRetry: ReturnType<typeof setTimeout> | undefined;
    let releaseRouteRetry: (() => void) | undefined;
    // Invalidate acknowledgements owned by a prior discovery run before any of its promises can publish.
    this.#atlasGeneration++;
    this.atlas = null;
    this.atlasReady = false;
    const stopRun = () => {
      current = false;
      clearTimeout(routeRetry);
      releaseRouteRetry?.();
      releaseRouteRetry = undefined;
    };
    this.#stop = stopRun;

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
      let foundRoutes: Routes | undefined;
      for (let attempt = 0; attempt <= ROUTE_RETRY_MS.length; attempt++) {
        try {
          foundRoutes = await this.fetchRouteTable();
          break;
        } catch (error) {
          if (!current || attempt === ROUTE_RETRY_MS.length) throw error;
          await new Promise<void>((resolve) => {
            releaseRouteRetry = resolve;
            routeRetry = setTimeout(resolve, ROUTE_RETRY_MS[attempt]);
          });
          routeRetry = undefined;
          releaseRouteRetry = undefined;
          if (!current) return;
        }
      }
      if (!foundRoutes) return;
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
        stopRun();
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
    clearTimeout(this.#grantRetry);
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
