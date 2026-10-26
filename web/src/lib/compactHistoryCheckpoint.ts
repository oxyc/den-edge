import {
  HISTORY_INDEX_POLICY,
  HISTORY_INDEX_SCHEMA,
  MaterializedHistoryIndex,
  type HistoryIndexSnapshot,
} from './historyIndex';
import type { LibraryFactManifest } from './libraryFactStore';

export const COMPACT_HISTORY_CHECKPOINT_SCHEMA = 1;

export interface CompactHistoryCheckpoint {
  schema: typeof COMPACT_HISTORY_CHECKPOINT_SCHEMA;
  snapshot: HistoryIndexSnapshot;
  /** Opaque fact-document keys grouped by their plaintext title inside the encrypted value. */
  documents: Array<[title: string, keys: string[]]>;
}

export const historyCheckpointSource = (
  manifest: LibraryFactManifest,
  reconsiderAt: number | null = manifest.newest?.reconsiderAt ?? null,
): HistoryIndexSnapshot['source'] => ({
  generation: manifest.generation,
  version: manifest.rowsVersion ?? manifest.head,
  revision: manifest.revision ?? `legacy:${manifest.head}`,
  reconsiderAt,
});

export const historyCheckpointMatches = (
  checkpoint: CompactHistoryCheckpoint,
  manifest: LibraryFactManifest,
): boolean => {
  const expected = historyCheckpointSource(manifest);
  const source = checkpoint.snapshot.source;
  return (
    checkpoint.schema === COMPACT_HISTORY_CHECKPOINT_SCHEMA &&
    checkpoint.snapshot.schema === HISTORY_INDEX_SCHEMA &&
    checkpoint.snapshot.policy === HISTORY_INDEX_POLICY &&
    source.generation === expected.generation &&
    source.version === expected.version &&
    source.revision === expected.revision &&
    (source.reconsiderAt === null || Number.isFinite(source.reconsiderAt))
  );
};

export const restoreHistoryCheckpoint = (
  value: unknown,
  manifest: LibraryFactManifest,
): { checkpoint: CompactHistoryCheckpoint; index: MaterializedHistoryIndex } | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const checkpoint = value as CompactHistoryCheckpoint;
  if (!historyCheckpointMatches(checkpoint, manifest) || !Array.isArray(checkpoint.documents))
    return null;
  const seen = new Set<string>();
  const documentKeys = new Set<string>();
  if (checkpoint.documents.length > 100_000) return null;
  for (const member of checkpoint.documents) {
    if (
      !Array.isArray(member) ||
      member.length !== 2 ||
      typeof member[0] !== 'string' ||
      !/^(movie|tv):[1-9][0-9]*$/.test(member[0]) ||
      seen.has(member[0]) ||
      !Array.isArray(member[1]) ||
      member[1].length > 10_000 ||
      member[1].some((key) => typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) ||
      new Set(member[1]).size !== member[1].length ||
      member[1].some((key) => documentKeys.has(key))
    )
      return null;
    seen.add(member[0]);
    for (const key of member[1]) documentKeys.add(key);
    if (documentKeys.size > 200_000) return null;
  }
  const index = MaterializedHistoryIndex.restore(checkpoint.snapshot);
  return index ? { checkpoint, index } : null;
};
