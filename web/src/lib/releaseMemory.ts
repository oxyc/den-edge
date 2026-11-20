// A deliberate series release choice, retained for this tab across reloads. The row contains Scout's opaque,
// stable season-pack identity, never a release filename. Its storage name is a digest of every authority which may
// make that identity meaningful, so changing profile, profile library, household or source add-on cannot reuse it.

import { localAuthorityKey } from './localAuthorityKey';

/** Profile, profile library, household, add-on install and source base, in that order. The compact tuple crosses
 * the always-loaded Library → lazy Player boundary without duplicating those field names in the startup chunk. */
export type ReleaseAuthority = readonly [
  profile: string,
  library: string | null,
  household: string | null,
  addon: string,
  source: string,
];

export interface SeriesReleaseMemory {
  season: number;
  group: string;
}

/** Every mutable player coordinate which owns publication of an asynchronous retained-memory answer. */
export interface ReleaseRecallGeneration {
  authority: string;
  episode: number;
  session: number;
  choice: number;
}

/** Return a retained answer only while the exact player operation which asked for it still owns the coordinate. */
export async function currentReleaseRecall<T>(
  pending: Promise<T>,
  expected: ReleaseRecallGeneration,
  current: () => ReleaseRecallGeneration | undefined,
): Promise<T | undefined> {
  const answer = await pending;
  const generation = current();
  return generation &&
    generation.authority === expected.authority &&
    generation.episode === expected.episode &&
    generation.session === expected.session &&
    generation.choice === expected.choice
    ? answer
    : undefined;
}

interface StoredSeriesReleaseMemory extends SeriesReleaseMemory {
  version: 1;
}

const PREFIX = 'den.release.v2.';
const LEGACY_PREFIX = 'den.releases.';
const MAX_GROUP_LENGTH = 512;

function store(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

const authorityText = (authority: ReleaseAuthority): string => JSON.stringify(authority);

const base64url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

async function digestAuthority(authority: ReleaseAuthority): Promise<string> {
  const value = authorityText(authority);
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
      return base64url(new Uint8Array(digest).subarray(0, 18));
    }
  } catch {
    // Older TV webviews can expose crypto without a working digest implementation.
  }
  return localAuthorityKey(value);
}

/** Remove filename-bearing rows written before authority scoping. They cannot be migrated: their owner and source
 * are unknowable, so deleting them is the only safe migration. */
function removeLegacyRows(storage: Storage | undefined): void {
  if (!storage) return;
  try {
    const legacy: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(LEGACY_PREFIX)) legacy.push(key);
    }
    for (const key of legacy) storage.removeItem(key);
  } catch {
    // Refused or incomplete storage means there is no trustworthy retained choice to read.
  }
}

export class ScopedReleaseMemory {
  readonly #prefix: string;
  readonly #storage: Storage | undefined;

  private constructor(scope: string, storage: Storage | undefined) {
    this.#prefix = `${PREFIX}${scope}.`;
    this.#storage = storage;
  }

  static async open(
    authority: ReleaseAuthority,
    storage: Storage | undefined = store(),
  ): Promise<ScopedReleaseMemory> {
    removeLegacyRows(storage);
    return new ScopedReleaseMemory(await digestAuthority(authority), storage);
  }

  #key(title: string): string {
    return `${this.#prefix}${title}`;
  }

  recall(title: string, season: number | undefined): SeriesReleaseMemory | undefined {
    if (season === undefined) return undefined;
    try {
      const value = JSON.parse(
        this.#storage?.getItem(this.#key(title)) ?? 'null',
      ) as Partial<StoredSeriesReleaseMemory> | null;
      if (
        value?.version !== 1 ||
        value.season !== season ||
        typeof value.group !== 'string' ||
        !value.group ||
        value.group.length > MAX_GROUP_LENGTH
      )
        return undefined;
      return { season, group: value.group };
    } catch {
      return undefined;
    }
  }

  remember(title: string, memory: SeriesReleaseMemory): void {
    if (
      !Number.isSafeInteger(memory.season) ||
      !memory.group ||
      memory.group.length > MAX_GROUP_LENGTH
    )
      return;
    try {
      this.#storage?.setItem(
        this.#key(title),
        JSON.stringify({ version: 1, ...memory } satisfies StoredSeriesReleaseMemory),
      );
    } catch (error) {
      // A private window or a full store: the pick still holds in this mounted player.
      console.warn('Couldn’t keep this series’ release choice for a reload.', error);
    }
  }

  forget(title: string): void {
    try {
      this.#storage?.removeItem(this.#key(title));
    } catch {
      // Inaccessible storage already cannot supply a remembered choice.
    }
  }
}
