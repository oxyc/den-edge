import {
  FINISHED_LIBRARY_POLICY,
  FINISHED_LIBRARY_RECOMMENDATIONS,
  FINISHED_LIBRARY_VIEWS_SCHEMA,
  readFinishedLibraryViews,
  staleFinishedLibraryViews,
  writeFinishedLibraryViews,
  type FinishedLibraryViewIdentity,
  type FinishedLibraryViews,
} from './finishedLibraryViews';
import { type LibraryFactManifest, LibraryFactStore } from './libraryFactStore';
import {
  LIBRARY_LOCAL_AUTHORITY,
  libraryLocalAuthorityRevision,
  validLibraryLocalAuthorityIdentity,
} from './libraryLocalAuthority';
import { readEncryptedLibraryValue, writeEncryptedLibraryValue } from './libraryLocalValue';
import type { Vault } from './localVault';
import type { LibrarySelectionValue } from './libraryServiceProtocol';
import { libraryMetadataShapeDigest } from './libraryMetadata';
import { ContinueProjector, type Shape } from './library';
import { continueItems, type HomeLibraryView } from './homeLibraryView';
import {
  selectedDevicesView,
  selectedRuntimeView,
  selectedSettingsView,
} from './librarySelectedSettings';
import type { SettingsRow } from './wire';
import { ensureSyncPolicy } from './syncLoader';

const WRITE_DELAY_MS = 250;

const factRef = (key: string) => {
  const [type, raw] = key.split(':');
  const id = Number(raw);
  if ((type !== 'movie' && type !== 'tv') || !Number.isSafeInteger(id) || id <= 0)
    throw new Error('Library fact contains an invalid title reference');
  return { type, id } as const;
};

export const factOverview = (
  home: HomeLibraryView,
): Extract<LibrarySelectionValue, { kind: 'overview' }> => ({
  kind: 'overview',
  owned: home.owned.map(factRef),
  watched: home.watched.map(factRef),
  watchlist: home.watchlist.map(factRef),
  standings: home.standings.map(([key, standing]) => ({
    title: factRef(key),
    standing: standing === 'inProgress' ? 'in-progress' : standing,
  })),
  weighted: home.weighted.map(([key, weight, updatedAt]) => ({
    title: factRef(key),
    weight,
    updatedAt,
  })),
  seeds: {
    watched: home.seeds.watched.map(factRef),
    watchlisted: home.seeds.watchlisted.map(factRef),
  },
});

export const factContinue = (
  home: HomeLibraryView,
  shapes: ReadonlyMap<string, Shape>,
  projector: ContinueProjector,
  devices: SettingsRow | undefined,
): Extract<LibrarySelectionValue, { kind: 'continue' }> => ({
  kind: 'continue',
  items: continueItems(projector, { ...home.continueLibrary, shapes: new Map(shapes) }, devices),
  needsShapes: home.requiredShapeRefs.filter((key) => !shapes.has(key)).map(factRef),
});

/** The one identity used by both the fact store's marker and its saved projections. */
export const factViewIdentity = (
  libraryId: string,
  manifest: LibraryFactManifest,
  reconsiderAt: number | null,
): FinishedLibraryViewIdentity => {
  const rowsVersion = manifest.rowsVersion ?? manifest.head;
  return {
    libraryId,
    generation: manifest.generation,
    head: manifest.head,
    authorityRevision: libraryLocalAuthorityRevision(manifest.head, rowsVersion, {
      stamp: manifest.newest?.stamp ?? null,
      revision: manifest.revision ?? null,
    }),
    policyVersion: FINISHED_LIBRARY_POLICY,
    rowsVersion,
    layoutVersion: 'facts',
    recommendationVersion: FINISHED_LIBRARY_RECOMMENDATIONS,
    reconsiderAt,
  };
};

export interface FinishedLibraryViewProjection {
  generation: string | null;
  head: number;
  /** When supplied by a fact authority, prove its lent projection is from this exact fact snapshot. */
  authorityRevision?: string;
  rowsVersion?: number;
  home?: HomeLibraryView;
  reconsiderAt?: number | null;
  shapes: ReadonlyMap<string, Shape>;
}

/**
 * One saved-view writer per authority. Fact commits and layout observations are coalesced into a durable projection.
 * A fact authority may lend Home with the same fact identity; the whole-log authority lends only title shapes,
 * because pending work can make its Home newer than the durable facts. Assistant policy is intentionally absent:
 * grant/read rows omit Settings while preserving the other capabilities. Selecting Settings promotes to the full,
 * time-aware authority before answering the flags that drive Home's background assistant work.
 */
export class FinishedLibraryViewWriter {
  readonly #projector = new ContinueProjector();
  readonly #stop: () => void;
  #timer?: ReturnType<typeof setTimeout>;
  #saving: Promise<void> = Promise.resolve();
  #closed = false;
  #aborted = false;
  #force = false;

  constructor(
    private readonly libraryKey: string,
    private readonly vault: Vault,
    private readonly store: LibraryFactStore,
    private readonly projection?: () => FinishedLibraryViewProjection | undefined,
  ) {
    this.#stop = store.listen(() => this.schedule());
  }

  schedule(force = false): void {
    if (this.#closed) return;
    this.#force ||= force;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#queue();
    }, WRITE_DELAY_MS);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      await this.#saving;
      return;
    }
    this.#closed = true;
    this.#stop();
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#queue();
    }
    await this.#saving;
  }

  /** Stop without deriving: ownership is moving to a full authority with its own fact-store listener. */
  async abort(): Promise<void> {
    if (this.#closed) {
      await this.#saving;
      return;
    }
    this.#closed = true;
    this.#aborted = true;
    this.#stop();
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#saving;
  }

  #queue(): void {
    const force = this.#force;
    this.#force = false;
    this.#saving = this.#saving
      .then(() => this.#write(force))
      .catch((error: unknown) =>
        console.warn('den: the library views could not be derived from facts', error),
      );
  }

  async #write(force: boolean): Promise<void> {
    if (this.#aborted) return;
    const manifest = await this.store.manifest();
    if (!manifest) {
      await staleFinishedLibraryViews(this.libraryKey, this.vault);
      return;
    }
    if (!manifest.complete) return;
    if (!force) {
      const [marker, cached] = await Promise.all([
        readEncryptedLibraryValue<unknown>(this.libraryKey, this.vault, LIBRARY_LOCAL_AUTHORITY),
        readFinishedLibraryViews(this.libraryKey, this.vault, []),
      ]);
      const expected = factViewIdentity(
        this.store.libraryId,
        manifest,
        cached?.identity.reconsiderAt ?? null,
      );
      if (
        validLibraryLocalAuthorityIdentity(marker) &&
        marker.generation === expected.generation &&
        marker.head === expected.head &&
        marker.authorityRevision === expected.authorityRevision &&
        marker.rowsVersion === expected.rowsVersion &&
        cached?.identity.generation === marker.generation &&
        cached.identity.head === marker.head &&
        cached.identity.authorityRevision === marker.authorityRevision &&
        cached.identity.rowsVersion === marker.rowsVersion &&
        cached.identity.policyVersion === FINISHED_LIBRARY_POLICY &&
        cached.identity.recommendationVersion === FINISHED_LIBRARY_RECOMMENDATIONS &&
        (cached.identity.reconsiderAt === null || cached.identity.reconsiderAt > Date.now())
      )
        return;
    }
    const supplied = this.projection?.();
    const expected = factViewIdentity(
      this.store.libraryId,
      manifest,
      supplied?.reconsiderAt ?? null,
    );
    const current =
      supplied?.generation === manifest.generation &&
      supplied.head === manifest.head &&
      supplied.authorityRevision === expected.authorityRevision &&
      supplied.rowsVersion === expected.rowsVersion
        ? supplied
        : undefined;
    if (!current?.home) await ensureSyncPolicy();
    const selected = current?.home
      ? { view: current.home, reconsiderAt: current.reconsiderAt ?? null }
      : await this.store.home(manifest.generation, ['watchlist', 'continue', 'recommendations']);
    // Shape observations are independent metadata. A whole-log authority may lend those, but not its Home projection:
    // pending rows can make that projection newer than the durable fact snapshot whose identity is published.
    const shapes = supplied?.shapes ?? new Map<string, Shape>();
    const [settingsRows, runtimeRows, deviceRows] = await Promise.all([
      this.store.settings(manifest.generation, 'settings'),
      this.store.settings(manifest.generation, 'runtime'),
      this.store.settings(manifest.generation, 'devices'),
    ]);
    // Grant/read rows need the assistant policy. `selectedSettingsView` returns null for them, so this background
    // writer omits only that capability instead of saving false connection flags. The other five views remain useful
    // on the next visit; asking for Settings promotes to the time-aware document authority.
    const settings = selectedSettingsView(settingsRows, manifest.profileTopology);
    const overview = factOverview(selected.view);
    const continued = factContinue(
      selected.view,
      shapes,
      this.#projector,
      deviceRows.find((row) => row.name === 'devices'),
    );
    if (continued.needsShapes.length) return;
    const required = new Set(selected.view.requiredShapeRefs);
    const layouts = Object.fromEntries(
      [...shapes]
        .filter(([key]) => required.has(key))
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, shape]) => [
          key,
          libraryMetadataShapeDigest({
            seasons: [...shape.counts].map(([season, episodes]) => ({ season, episodes })),
            ...(shape.lastAired ? { lastAired: shape.lastAired } : {}),
          }),
        ]),
    );
    const { kind: _kind, watchlist: _watchlist, ...recommendations } = overview;
    const value: FinishedLibraryViews = {
      schema: FINISHED_LIBRARY_VIEWS_SCHEMA,
      identity: factViewIdentity(this.store.libraryId, manifest, selected.reconsiderAt),
      pieces: {
        watchlist: { titles: overview.watchlist },
        recommendations,
        continue: { view: continued, layouts },
        ...(settings ? { settings } : {}),
        runtime: selectedRuntimeView(runtimeRows),
        devices: selectedDevicesView(deviceRows),
      },
    };
    if (this.#aborted) return;
    if (!(await writeFinishedLibraryViews(this.libraryKey, this.vault, value))) return;
    if (this.#aborted) return;
    await writeEncryptedLibraryValue(this.libraryKey, this.vault, LIBRARY_LOCAL_AUTHORITY, {
      generation: value.identity.generation,
      head: value.identity.head,
      authorityRevision: value.identity.authorityRevision,
      rowsVersion: value.identity.rowsVersion,
    });
  }
}
