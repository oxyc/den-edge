import { noteFinishedViewCache } from './libraryStartupMetrics';
import { libraryLocalKey } from './libraryLocalKey';
import type { Vault } from './localVault';
import type {
  ContinueView,
  LibraryOverviewView,
  RuntimeDiscoveryView,
  SettingsView,
} from './libraryServiceProtocol';
import { LIBRARY_SERVICE_PROTOCOL } from './libraryServiceProtocol';
import { decodeLibraryServiceServerMessage } from './libraryServiceProtocolCodec';
import { deriveKeys } from './wire';

export const FINISHED_LIBRARY_VIEWS_SCHEMA = 1;
export const FINISHED_LIBRARY_POLICY = 1;
export const FINISHED_LIBRARY_RECOMMENDATIONS = 1;
const NAME = 'finished-views.v1';
const utf8 = new TextEncoder();
const text = new TextDecoder();
const CAPABILITIES: readonly FinishedLibraryViewCapability[] = [
  'watchlist',
  'continue',
  'recommendations',
  'settings',
  'runtime',
];

/** Independently retained pieces. A client need not accept the full Home/history surface to use one of them. */
export interface FinishedLibraryViewPieces {
  watchlist: { titles: LibraryOverviewView['watchlist'] };
  continue: { view: ContinueView; layouts: Record<string, string> };
  recommendations: Omit<LibraryOverviewView, 'kind' | 'watchlist'>;
  settings: SettingsView;
  runtime: RuntimeDiscoveryView;
}

export type FinishedLibraryViewCapability = keyof FinishedLibraryViewPieces;

export interface FinishedLibraryViewIdentity {
  libraryId: string;
  generation: string;
  head: number;
  /** Includes local/pending changes not represented by `head`. */
  authorityRevision: string;
  policyVersion: number;
  profileVersion: string;
  layoutVersion: string;
  recommendationVersion: number;
  reconsiderAt: number | null;
}

export interface FinishedLibraryViews {
  schema: typeof FINISHED_LIBRARY_VIEWS_SCHEMA;
  identity: FinishedLibraryViewIdentity;
  pieces: Partial<FinishedLibraryViewPieces>;
}

const rawLibraryKey = (encoded: string): Uint8Array<ArrayBuffer> | null => {
  try {
    const raw = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    if (raw.length !== 32 || btoa(String.fromCharCode(...raw)) !== encoded) return null;
    return raw;
  } catch {
    return null;
  }
};

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
    typeof held.profileVersion === 'string' &&
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

async function materials(libraryKey: string) {
  const raw = rawLibraryKey(libraryKey);
  if (!raw) return null;
  try {
    const keys = await deriveKeys(raw);
    return { libraryId: keys.id, key: await libraryLocalKey(raw) };
  } finally {
    raw.fill(0);
  }
}

async function sealValue(key: CryptoKey, aad: string, value: unknown): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8.encode(aad) },
    key,
    utf8.encode(JSON.stringify(value)),
  );
  const bytes = new Uint8Array(iv.length + sealed.byteLength);
  bytes.set(iv);
  bytes.set(new Uint8Array(sealed), iv.length);
  return bytes;
}

async function openValue(key: CryptoKey, aad: string, bytes: Uint8Array): Promise<unknown> {
  if (bytes.length < 13) throw new Error('truncated cache value');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: utf8.encode(aad) },
    key,
    bytes.slice(12),
  );
  return JSON.parse(text.decode(plain)) as unknown;
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
  const local = await materials(libraryKey);
  if (!local) return null;
  const manifestBytes = await vault.get(storedKey(local.libraryId));
  if (!manifestBytes) return null;
  noteFinishedViewCache('read', manifestBytes.byteLength);
  try {
    const manifest = await openValue(local.key, NAME, manifestBytes);
    if (!validManifest(manifest) || manifest.identity.libraryId !== local.libraryId) return null;
    if (capabilities.some((capability) => !manifest.capabilities.includes(capability))) return null;
    const pieces: Partial<FinishedLibraryViewPieces> = {};
    for (const capability of capabilities) {
      const aad = `${NAME}:${manifest.revision}:${capability}`;
      const bytes = await vault.get(pieceKey(local.libraryId, manifest.revision, capability));
      if (!bytes) return null;
      noteFinishedViewCache('read', bytes.byteLength);
      const piece = await openValue(local.key, aad, bytes);
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

/** Open one of LibraryLog's small encrypted retained values without opening its document snapshot. */
export async function readEncryptedLibraryValue<T>(
  libraryKey: string,
  vault: Vault,
  name: string,
): Promise<T | undefined> {
  const local = await materials(libraryKey);
  if (!local) return undefined;
  const bytes = await vault.get(`${local.libraryId}:${name}`);
  if (!bytes) return undefined;
  noteFinishedViewCache('read', bytes.byteLength);
  try {
    return (await openValue(local.key, name, bytes)) as T;
  } catch {
    return undefined;
  }
}

/** Replace one of LibraryLog's small encrypted retained values without opening its document snapshot. */
export async function writeEncryptedLibraryValue(
  libraryKey: string,
  vault: Vault,
  name: string,
  value: unknown,
): Promise<boolean> {
  const local = await materials(libraryKey);
  if (!local) return false;
  const bytes = await sealValue(local.key, name, value);
  await vault.put(`${local.libraryId}:${name}`, bytes);
  noteFinishedViewCache('write', bytes.byteLength);
  return true;
}

/** Write immutable pieces first and publish their manifest last, so interruption preserves the previous complete set. */
export async function writeFinishedLibraryViews(
  libraryKey: string,
  vault: Vault,
  value: FinishedLibraryViews,
): Promise<boolean> {
  const local = await materials(libraryKey);
  if (!local || !validEnvelope(value) || value.identity.libraryId !== local.libraryId) return false;
  let previous: FinishedLibraryViewManifest | undefined;
  const previousBytes = await vault.get(storedKey(local.libraryId));
  if (previousBytes)
    try {
      const opened = await openValue(local.key, NAME, previousBytes);
      if (validManifest(opened) && opened.identity.libraryId === local.libraryId) previous = opened;
    } catch {
      // A corrupt prior generation is replaced by the new, complete generation below.
    }
  const nextRevision = revision();
  const capabilities = Object.keys(value.pieces) as FinishedLibraryViewCapability[];
  for (const capability of capabilities) {
    const aad = `${NAME}:${nextRevision}:${capability}`;
    const bytes = await sealValue(local.key, aad, value.pieces[capability]);
    await vault.put(pieceKey(local.libraryId, nextRevision, capability), bytes);
    noteFinishedViewCache('write', bytes.byteLength);
  }
  const manifest: FinishedLibraryViewManifest = {
    schema: value.schema,
    identity: value.identity,
    revision: nextRevision,
    capabilities,
  };
  const bytes = await sealValue(local.key, NAME, manifest);
  await vault.put(storedKey(local.libraryId), bytes);
  noteFinishedViewCache('write', bytes.byteLength);
  if (previous && previous.revision !== nextRevision)
    await Promise.allSettled(
      previous.capabilities.map((capability) =>
        vault.delete(pieceKey(local.libraryId, previous.revision, capability)),
      ),
    );
  return true;
}

/** Every uncertain input is a miss; time-dependent Continue is reusable only before its next reconsideration. */
export function reusableFinishedLibraryViews(
  cached: FinishedLibraryViewIdentity,
  expected: Omit<FinishedLibraryViewIdentity, 'reconsiderAt'>,
  now = Date.now(),
): boolean {
  return (
    cached.libraryId === expected.libraryId &&
    cached.generation === expected.generation &&
    cached.head === expected.head &&
    cached.authorityRevision === expected.authorityRevision &&
    cached.policyVersion === expected.policyVersion &&
    cached.profileVersion === expected.profileVersion &&
    cached.layoutVersion === expected.layoutVersion &&
    cached.recommendationVersion === expected.recommendationVersion &&
    (cached.reconsiderAt === null || cached.reconsiderAt > now)
  );
}
