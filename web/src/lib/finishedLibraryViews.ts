import { noteFinishedViewsRewrite, noteLibraryCacheIO } from './libraryStartupMetrics';
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

/** Where each piece is kept (`revision`) and the SHA-256 of what it says: a piece that says the same is kept as is. */
type KeptPieces = Partial<
  Record<FinishedLibraryViewCapability, { revision: string; digest: string }>
>;

interface FinishedLibraryViewManifest {
  schema: typeof FINISHED_LIBRARY_VIEWS_SCHEMA;
  identity: FinishedLibraryViewIdentity;
  pieces: KeptPieces;
  /** Of a revision the library has moved past (`staleFinishedLibraryViews`): never opened, its pieces kept. */
  stale?: true;
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
    (held.stale === undefined || held.stale === true) &&
    !!held.pieces &&
    typeof held.pieces === 'object' &&
    !Array.isArray(held.pieces) &&
    Object.entries(held.pieces).every(
      ([capability, piece]) =>
        CAPABILITIES.includes(capability as FinishedLibraryViewCapability) &&
        typeof piece?.revision === 'string' &&
        /^[0-9a-f]{32}$/.test(piece.revision) &&
        typeof piece.digest === 'string' &&
        /^[0-9a-f]{64}$/.test(piece.digest),
    )
  );
};

const pieceDigest = async (piece: unknown): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(piece))),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

/**
 * The same library state. Not `layoutVersion`: a counter of the layouts a page learnt, which every visit moves again
 * from zero, while the layouts the views were drawn with are in `continue.layouts` already.
 */
const sameState = (left: FinishedLibraryViewIdentity, right: FinishedLibraryViewIdentity) =>
  (Object.keys(left) as Array<keyof FinishedLibraryViewIdentity>).every(
    (field) => field === 'layoutVersion' || left[field] === right[field],
  );

/** The kept manifest, when it opens and is this library's; null otherwise. */
async function keptManifest(
  local: NonNullable<Awaited<ReturnType<typeof libraryLocalMaterials>>>,
  vault: Vault,
): Promise<FinishedLibraryViewManifest | null> {
  const bytes = await vault.get(storedKey(local.libraryId));
  if (!bytes) return null;
  try {
    const manifest = await openLibraryLocalValue(local.key, NAME, bytes);
    return validManifest(manifest) && manifest.identity.libraryId === local.libraryId
      ? manifest
      : null;
  } catch {
    return null;
  }
}

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
    if (
      !validManifest(manifest) ||
      manifest.stale ||
      manifest.identity.libraryId !== local.libraryId
    )
      return null;
    if (capabilities.some((capability) => !manifest.pieces[capability])) return null;
    const pieces: Partial<FinishedLibraryViewPieces> = {};
    for (const capability of capabilities) {
      const { revision } = manifest.pieces[capability]!;
      const aad = `${NAME}:${revision}:${capability}`;
      const bytes = await vault.get(pieceKey(local.libraryId, revision, capability));
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
 * Make the kept views unusable before a new revision is assembled, without removing their pieces: the next write
 * names each one that still says the same again instead of writing it.
 */
export async function staleFinishedLibraryViews(libraryKey: string, vault: Vault): Promise<void> {
  const local = await libraryLocalMaterials(libraryKey);
  if (!local) return;
  const kept = await keptManifest(local, vault);
  if (!kept || kept.stale) return;
  noteFinishedViewsRewrite('stale');
  const bytes = await sealLibraryLocalValue(local.key, NAME, { ...kept, stale: true });
  await vault.put(storedKey(local.libraryId), bytes);
  noteLibraryCacheIO('write', bytes.byteLength);
}

/**
 * Write the pieces that say something the kept ones do not, each under a new revision, and publish their manifest
 * last, so interruption preserves the previous complete set. A piece that says the same is named again where it is.
 */
export async function writeFinishedLibraryViews(
  libraryKey: string,
  vault: Vault,
  value: FinishedLibraryViews,
): Promise<boolean> {
  const local = await libraryLocalMaterials(libraryKey);
  if (!local || !validEnvelope(value) || value.identity.libraryId !== local.libraryId) return false;
  const capabilities = Object.keys(value.pieces) as FinishedLibraryViewCapability[];
  const kept = await keptManifest(local, vault);
  const nextRevision = revision();
  const pieces: KeptPieces = {};
  const changed: FinishedLibraryViewCapability[] = [];
  for (const capability of capabilities) {
    const digest = await pieceDigest(value.pieces[capability]);
    const held = kept?.pieces[capability];
    if (held?.digest === digest) pieces[capability] = held;
    else {
      pieces[capability] = { revision: nextRevision, digest };
      changed.push(capability);
    }
  }
  const dropped = Object.keys(kept?.pieces ?? {}).filter(
    (capability) => !capabilities.includes(capability as FinishedLibraryViewCapability),
  );
  // A returning visit that opened the whole log recomputes the views it already keeps: nothing to write then.
  if (
    kept &&
    !kept.stale &&
    !changed.length &&
    !dropped.length &&
    sameState(kept.identity, value.identity)
  )
    return true;
  noteFinishedViewsRewrite(kept ? `write:${changed.join(',') || 'identity'}` : 'write:none kept');
  for (const capability of changed) {
    const aad = `${NAME}:${nextRevision}:${capability}`;
    const bytes = await sealLibraryLocalValue(local.key, aad, value.pieces[capability]);
    await vault.put(pieceKey(local.libraryId, nextRevision, capability), bytes);
    noteLibraryCacheIO('write', bytes.byteLength);
  }
  const manifest: FinishedLibraryViewManifest = {
    schema: value.schema,
    identity: value.identity,
    pieces,
  };
  const bytes = await sealLibraryLocalValue(local.key, NAME, manifest);
  await vault.put(storedKey(local.libraryId), bytes);
  noteLibraryCacheIO('write', bytes.byteLength);
  if (!changed.length && !dropped.length) return true;
  // What the manifest no longer names: the pieces replaced, and any an interrupted write left behind.
  const active = new Set(
    Object.entries(pieces).map(([capability, { revision }]) =>
      pieceKey(local.libraryId, revision, capability as FinishedLibraryViewCapability),
    ),
  );
  const storedPieces = await vault.entries(`${storedKey(local.libraryId)}:`);
  await Promise.allSettled(
    storedPieces.flatMap(([key]) => (active.has(key) ? [] : [vault.delete(key)])),
  );
  return true;
}
