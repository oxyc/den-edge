import { noteFinishedViewsRewrite, noteLibraryCacheIO } from './libraryStartupMetrics';
import {
  libraryLocalMaterials,
  openLibraryLocalValue,
  sealLibraryLocalValue,
} from './libraryLocalValue';
import {
  LIBRARY_LOCAL_AUTHORITY,
  type LibraryLocalAuthorityIdentity,
} from './libraryLocalAuthority';
import type { Vault, VaultChange } from './localVault';
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
// Version 2 invalidates settings views that could have recorded live assistant grants/reads as false.
export const FINISHED_LIBRARY_POLICY = 2;
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
const pieceKey = (libraryId: string, revision: string, part: PartName) =>
  `${storedKey(libraryId)}:${revision}:${part}`;

/**
 * The recommendations piece names every title in the library, so it is kept as a head (`seeds`) and `SHARDS` parts by
 * title: an edit of one title rewrites the one part that holds it, not the whole library's lists.
 */
const SHARDS = 32;
type ShardName = `recommendations.${string}`;
type PartName = FinishedLibraryViewCapability | ShardName;
const shardName = (shard: number): ShardName => `recommendations.${String(shard).padStart(2, '0')}`;
const SHARD_NAMES = Array.from({ length: SHARDS }, (_, shard) => shardName(shard));
const refKey = (ref: { type: string; id: number }) => `${ref.type}:${ref.id}`;
const shardOf = (ref: { type: string; id: number }) => {
  let hash = 0x811c9dc5;
  for (const character of refKey(ref)) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193);
  return (hash >>> 0) % SHARDS;
};
type Recommendations = FinishedLibraryViewPieces['recommendations'];
type RecommendationLists = Omit<Recommendations, 'seeds'>;
const LISTS = ['owned', 'watched', 'standings', 'weighted'] as const;
const listRef = (entry: Recommendations[(typeof LISTS)[number]][number]) =>
  'title' in entry ? entry.title : entry;

/** A capability's piece as the parts it is kept in. */
function partsOf(
  capability: FinishedLibraryViewCapability,
  piece: unknown,
): Array<[PartName, unknown]> {
  if (capability !== 'recommendations') return [[capability, piece]];
  const { seeds, ...lists } = piece as Recommendations;
  const shards = SHARD_NAMES.map((): RecommendationLists => ({
    owned: [],
    watched: [],
    standings: [],
    weighted: [],
  }));
  for (const name of LISTS)
    for (const entry of lists[name])
      (shards[shardOf(listRef(entry))]![name] as unknown[]).push(entry);
  return [
    ['recommendations', { seeds }],
    ...shards.map((shard, index): [PartName, unknown] => [SHARD_NAMES[index]!, shard]),
  ];
}

/** The recommendations piece from its head and parts: each list in title-key order, the order it is drawn in. */
function wholeRecommendations(head: { seeds: Recommendations['seeds'] }, shards: unknown[]) {
  const whole: RecommendationLists = { owned: [], watched: [], standings: [], weighted: [] };
  for (const shard of shards as RecommendationLists[])
    for (const name of LISTS) (whole[name] as unknown[]).push(...shard[name]);
  for (const name of LISTS)
    (whole[name] as Array<Recommendations[typeof name][number]>).sort((left, right) => {
      const [a, b] = [refKey(listRef(left)), refKey(listRef(right))];
      return a < b ? -1 : a > b ? 1 : 0;
    });
  return { ...whole, seeds: head.seeds };
}

/** Where each part is kept (`revision`) and the SHA-256 of what it says: a part that says the same is kept as is. */
type KeptPieces = Partial<Record<PartName, { revision: string; digest: string }>>;

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
      ([part, piece]) =>
        (CAPABILITIES.includes(part as FinishedLibraryViewCapability) ||
          SHARD_NAMES.includes(part as ShardName)) &&
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

interface ManifestSnapshot {
  /** The exact encrypted bytes used as the publication precondition, including unreadable bytes. */
  bytes: Uint8Array | undefined;
  /** The kept manifest, when it opens and is this library's. */
  manifest: FinishedLibraryViewManifest | null;
}

/** The manifest and the exact encrypted bytes it was read from. */
async function keptManifest(
  local: NonNullable<Awaited<ReturnType<typeof libraryLocalMaterials>>>,
  vault: Vault,
): Promise<ManifestSnapshot> {
  const bytes = await vault.get(storedKey(local.libraryId));
  if (!bytes) return { bytes, manifest: null };
  try {
    const manifest = await openLibraryLocalValue(local.key, NAME, bytes);
    return {
      bytes,
      manifest:
        validManifest(manifest) && manifest.identity.libraryId === local.libraryId
          ? manifest
          : null,
    };
  } catch {
    return { bytes, manifest: null };
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
    const part = async (name: PartName): Promise<unknown> => {
      const kept = manifest.pieces[name];
      if (!kept) return undefined;
      const bytes = await vault.get(pieceKey(local.libraryId, kept.revision, name));
      if (!bytes) return undefined;
      noteLibraryCacheIO('read', bytes.byteLength);
      return openLibraryLocalValue(local.key, `${NAME}:${kept.revision}:${name}`, bytes);
    };
    const pieces: Partial<FinishedLibraryViewPieces> = {};
    for (const capability of capabilities) {
      let piece = await part(capability);
      if (piece && capability === 'recommendations') {
        const shards = await Promise.all(SHARD_NAMES.map(part));
        if (shards.some((shard) => !shard || typeof shard !== 'object')) return null;
        piece = wholeRecommendations(piece as { seeds: Recommendations['seeds'] }, shards);
      }
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
  const { bytes: expected, manifest: kept } = await keptManifest(local, vault);
  if (!kept || kept.stale) return;
  const compareAndCommit = vault.compareAndCommit;
  if (!compareAndCommit) return;
  const bytes = await sealLibraryLocalValue(local.key, NAME, { ...kept, stale: true });
  if (
    !(await compareAndCommit.call(vault, storedKey(local.libraryId), expected, [
      { kind: 'put', key: storedKey(local.libraryId), value: bytes },
    ]))
  )
    return;
  noteFinishedViewsRewrite('stale');
  noteLibraryCacheIO('write', bytes.byteLength);
}

/**
 * Prepare the pieces that say something the kept ones do not, then atomically publish them with their manifest,
 * caller-supplied identity values, and cleanup only if the encrypted manifest read before preparation is still
 * current. A piece that says the same is named again where it is. A competing publisher wins without this attempt
 * writing or deleting.
 */
export async function writeFinishedLibraryViews(
  libraryKey: string,
  vault: Vault,
  value: FinishedLibraryViews,
  authority?: LibraryLocalAuthorityIdentity,
): Promise<boolean> {
  const local = await libraryLocalMaterials(libraryKey);
  if (!local || !validEnvelope(value) || value.identity.libraryId !== local.libraryId) return false;
  const parts = new Map(
    (Object.keys(value.pieces) as FinishedLibraryViewCapability[]).flatMap((capability) =>
      partsOf(capability, value.pieces[capability]),
    ),
  );
  const { bytes: expected, manifest: kept } = await keptManifest(local, vault);
  const nextRevision = revision();
  const pieces: KeptPieces = {};
  const changed: PartName[] = [];
  for (const [part, piece] of parts) {
    const digest = await pieceDigest(piece);
    const held = kept?.pieces[part];
    if (held?.digest === digest) pieces[part] = held;
    else {
      pieces[part] = { revision: nextRevision, digest };
      changed.push(part);
    }
  }
  const dropped = Object.keys(kept?.pieces ?? {}).filter((part) => !parts.has(part as PartName));
  const compareAndCommit = vault.compareAndCommit;
  if (!compareAndCommit) return false;
  const unchanged =
    kept &&
    !kept.stale &&
    !changed.length &&
    !dropped.length &&
    sameState(kept.identity, value.identity);
  const changes: VaultChange[] = [];
  const writtenBytes: number[] = [];
  if (!unchanged) {
    for (const part of changed) {
      const aad = `${NAME}:${nextRevision}:${part}`;
      const bytes = await sealLibraryLocalValue(local.key, aad, parts.get(part));
      changes.push({
        kind: 'put',
        key: pieceKey(local.libraryId, nextRevision, part),
        value: bytes,
      });
      writtenBytes.push(bytes.byteLength);
    }
    const manifest: FinishedLibraryViewManifest = {
      schema: value.schema,
      identity: value.identity,
      pieces,
    };
    const bytes = await sealLibraryLocalValue(local.key, NAME, manifest);
    changes.push({ kind: 'put', key: storedKey(local.libraryId), value: bytes });
    writtenBytes.push(bytes.byteLength);
    if (changed.length || dropped.length) {
      // What the manifest no longer names: replaced pieces and leftovers from an older interrupted implementation.
      const active = new Set(
        Object.entries(pieces).map(([part, held]) =>
          pieceKey(local.libraryId, held!.revision, part as PartName),
        ),
      );
      const storedPieces = await vault.entries(`${storedKey(local.libraryId)}:`);
      changes.push(
        ...storedPieces.flatMap(([key]): VaultChange[] =>
          active.has(key) ? [] : [{ kind: 'delete', key }],
        ),
      );
    }
  }
  if (authority) {
    const bytes = await sealLibraryLocalValue(local.key, LIBRARY_LOCAL_AUTHORITY, authority);
    changes.push({
      kind: 'put',
      key: `${local.libraryId}:${LIBRARY_LOCAL_AUTHORITY}`,
      value: bytes,
    });
    writtenBytes.push(bytes.byteLength);
  }
  if (!(await compareAndCommit.call(vault, storedKey(local.libraryId), expected, changes)))
    return false;
  if (!unchanged)
    noteFinishedViewsRewrite(kept ? `write:${changed.join(',') || 'identity'}` : 'write:none kept');
  for (const length of writtenBytes) noteLibraryCacheIO('write', length);
  return true;
}
