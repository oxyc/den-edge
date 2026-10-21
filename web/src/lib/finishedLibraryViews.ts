import { noteLibraryCacheIO } from './libraryStartupMetrics';
import {
  libraryLocalMaterials,
  openLibraryLocalValue,
  sealLibraryLocalValue,
} from './libraryLocalValue';
import type { Vault } from './localVault';
import type {
  ContinueView,
  DevicesView,
  LibraryOverviewView,
  RuntimeDiscoveryView,
  SettingsView,
} from './libraryServiceProtocol';
import { LIBRARY_SERVICE_PROTOCOL } from './libraryServiceProtocol';
import { decodeLibraryServiceServerMessage } from './libraryServiceProtocolCodec';

export const FINISHED_LIBRARY_VIEWS_SCHEMA = 1;
export const FINISHED_LIBRARY_POLICY = 1;
export const FINISHED_LIBRARY_RECOMMENDATIONS = 1;
const NAME = 'finished-views.v1';
const CAPABILITIES: readonly FinishedLibraryViewCapability[] = [
  'watchlist',
  'continue',
  'recommendations',
  'settings',
  'runtime',
  'devices',
];

/** Independently retained pieces. A client need not accept the full Home/history surface to use one of them. */
export interface FinishedLibraryViewPieces {
  watchlist: { titles: LibraryOverviewView['watchlist'] };
  continue: { view: ContinueView; layouts: Record<string, string> };
  recommendations: Omit<LibraryOverviewView, 'kind' | 'watchlist'>;
  settings: SettingsView;
  runtime: RuntimeDiscoveryView;
  devices: DevicesView;
}

export type FinishedLibraryViewCapability = keyof FinishedLibraryViewPieces;

export interface FinishedLibraryViewIdentity {
  libraryId: string;
  generation: string;
  head: number;
  /** Includes local/pending changes not represented by `head`. */
  authorityRevision: string;
  policyVersion: number;
  rowsVersion: number;
  layoutVersion: string;
  recommendationVersion: number;
  reconsiderAt: number | null;
}

export interface FinishedLibraryViews {
  schema: typeof FINISHED_LIBRARY_VIEWS_SCHEMA;
  identity: FinishedLibraryViewIdentity;
  pieces: Partial<FinishedLibraryViewPieces>;
}

const storedKey = (libraryId: string) => `${libraryId}:${NAME}`;
const pieceKey = (libraryId: string, revision: string, capability: FinishedLibraryViewCapability) =>
  `${storedKey(libraryId)}:${revision}:${capability}`;

interface FinishedLibraryViewManifest {
  schema: typeof FINISHED_LIBRARY_VIEWS_SCHEMA;
  identity: FinishedLibraryViewIdentity;
  revision: string;
  capabilities: FinishedLibraryViewCapability[];
}

const validIdentity = (value: unknown): value is FinishedLibraryViewIdentity => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const held = value as Partial<FinishedLibraryViewIdentity>;
  return (
    typeof held.libraryId === 'string' &&
    /^[0-9a-f]{32}$/.test(held.libraryId) &&
    typeof held.generation === 'string' &&
    held.generation.length > 0 &&
    Number.isSafeInteger(held.head) &&
    held.head! >= 0 &&
    typeof held.authorityRevision === 'string' &&
    typeof held.policyVersion === 'number' &&
    Number.isSafeInteger(held.rowsVersion) &&
    held.rowsVersion! >= 0 &&
    typeof held.layoutVersion === 'string' &&
    typeof held.recommendationVersion === 'number' &&
    (held.reconsiderAt === null ||
      (typeof held.reconsiderAt === 'number' && Number.isFinite(held.reconsiderAt)))
  );
};

const validEnvelope = (value: unknown): value is FinishedLibraryViews => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const held = value as Partial<FinishedLibraryViews>;
  if (
    held.schema !== FINISHED_LIBRARY_VIEWS_SCHEMA ||
    !validIdentity(held.identity) ||
    !held.pieces ||
    typeof held.pieces !== 'object' ||
    Array.isArray(held.pieces)
  )
    return false;
  const known = new Set(CAPABILITIES);
  return Object.entries(held.pieces).every(
    ([name, piece]) =>
      known.has(name as FinishedLibraryViewCapability) &&
      validPiece(name as FinishedLibraryViewCapability, piece),
  );
};

const validSelectionValue = (value: unknown): boolean =>
  decodeLibraryServiceServerMessage({
    type: 'update',
    protocol: LIBRARY_SERVICE_PROTOCOL,
    subscriptionId: 'finished-view-cache',
    version: { instance: 'finished-view-cache', generation: null, revision: 0 },
    value,
  }).ok;

const validPiece = (
  capability: FinishedLibraryViewCapability,
  value: unknown,
): value is FinishedLibraryViewPieces[FinishedLibraryViewCapability] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const held = value as Record<string, unknown>;
  if (capability === 'watchlist')
    return (
      Object.keys(held).every((key) => key === 'titles') &&
      validSelectionValue({
        kind: 'overview',
        owned: [],
        watched: [],
        watchlist: held.titles,
        standings: [],
        weighted: [],
        seeds: { watched: [], watchlisted: [] },
      })
    );
  if (capability === 'recommendations')
    return (
      Object.keys(held).every((key) =>
        ['owned', 'watched', 'standings', 'weighted', 'seeds'].includes(key),
      ) && validSelectionValue({ kind: 'overview', ...held, watchlist: [] })
    );
  if (capability === 'continue')
    return (
      Object.keys(held).every((key) => key === 'view' || key === 'layouts') &&
      validSelectionValue(held.view) &&
      !!held.layouts &&
      typeof held.layouts === 'object' &&
      !Array.isArray(held.layouts) &&
      Object.entries(held.layouts).every(
        ([key, digest]) => /^tv:[1-9]\d*$/.test(key) && typeof digest === 'string',
      )
    );
  return validSelectionValue(held);
};

const validManifest = (value: unknown): value is FinishedLibraryViewManifest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const held = value as Partial<FinishedLibraryViewManifest>;
  return (
    held.schema === FINISHED_LIBRARY_VIEWS_SCHEMA &&
    validIdentity(held.identity) &&
    typeof held.revision === 'string' &&
    /^[0-9a-f]{32}$/.test(held.revision) &&
    Array.isArray(held.capabilities) &&
    held.capabilities.every((capability) => CAPABILITIES.includes(capability)) &&
    new Set(held.capabilities).size === held.capabilities.length
  );
};

const revision = (): string =>
  [...crypto.getRandomValues(new Uint8Array(16))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');

/** Authenticate and open only the small selected view; it never opens the saved document snapshot. */
export async function readFinishedLibraryViews(
  libraryKey: string,
  vault: Vault,
  capabilities: readonly FinishedLibraryViewCapability[],
): Promise<FinishedLibraryViews | null> {
  const local = await libraryLocalMaterials(libraryKey);
  if (!local) return null;
  const manifestBytes = await vault.get(storedKey(local.libraryId));
  if (!manifestBytes) return null;
  noteLibraryCacheIO('read', manifestBytes.byteLength);
  try {
    const manifest = await openLibraryLocalValue(local.key, NAME, manifestBytes);
    if (!validManifest(manifest) || manifest.identity.libraryId !== local.libraryId) return null;
    if (capabilities.some((capability) => !manifest.capabilities.includes(capability))) return null;
    const pieces: Partial<FinishedLibraryViewPieces> = {};
    for (const capability of capabilities) {
      const aad = `${NAME}:${manifest.revision}:${capability}`;
      const bytes = await vault.get(pieceKey(local.libraryId, manifest.revision, capability));
      if (!bytes) return null;
      noteLibraryCacheIO('read', bytes.byteLength);
      const piece = await openLibraryLocalValue(local.key, aad, bytes);
      if (!validPiece(capability, piece)) return null;
      Object.assign(pieces, { [capability]: piece });
    }
    return {
      schema: manifest.schema,
      identity: manifest.identity,
      pieces,
    };
  } catch {
    return null;
  }
}

/**
 * Make every finished view unusable before a new authority revision is assembled. Removing the shared prefix also
 * collects immutable pieces left by an interrupted replacement.
 */
export async function removeFinishedLibraryViews(
  libraryKey: string,
  vault: Vault,
): Promise<boolean> {
  const local = await libraryLocalMaterials(libraryKey);
  if (!local) return false;
  const manifest = storedKey(local.libraryId);
  await vault.delete(manifest);
  await vault.remove(`${manifest}:`);
  return true;
}

/** Write immutable pieces first and publish their manifest last, so interruption preserves the previous complete set. */
export async function writeFinishedLibraryViews(
  libraryKey: string,
  vault: Vault,
  value: FinishedLibraryViews,
): Promise<boolean> {
  const local = await libraryLocalMaterials(libraryKey);
  if (!local || !validEnvelope(value) || value.identity.libraryId !== local.libraryId) return false;
  const nextRevision = revision();
  const capabilities = Object.keys(value.pieces) as FinishedLibraryViewCapability[];
  for (const capability of capabilities) {
    const aad = `${NAME}:${nextRevision}:${capability}`;
    const bytes = await sealLibraryLocalValue(local.key, aad, value.pieces[capability]);
    await vault.put(pieceKey(local.libraryId, nextRevision, capability), bytes);
    noteLibraryCacheIO('write', bytes.byteLength);
  }
  const manifest: FinishedLibraryViewManifest = {
    schema: value.schema,
    identity: value.identity,
    revision: nextRevision,
    capabilities,
  };
  const bytes = await sealLibraryLocalValue(local.key, NAME, manifest);
  await vault.put(storedKey(local.libraryId), bytes);
  noteLibraryCacheIO('write', bytes.byteLength);
  const active = new Set(
    capabilities.map((capability) => pieceKey(local.libraryId, nextRevision, capability)),
  );
  const storedPieces = await vault.entries(`${storedKey(local.libraryId)}:`);
  await Promise.allSettled(
    storedPieces.flatMap(([key]) => (active.has(key) ? [] : [vault.delete(key)])),
  );
  return true;
}
