// What a tab remembers of one title's (or episode's) releases across a reload of the player: the release the viewer
// picked, which nothing moves them off on its own, and the ones playback left — switched away from, or a decoder
// refused — which no automatic pick lands on again. Per tab (`sessionStorage`): a new visit starts clean.

export interface ReleaseMemory {
  /** The viewer's own pick, by filename. */
  chosen?: string;
  /** Releases left this visit, by filename. */
  left: string[];
}

const PREFIX = 'den.releases.';

function store(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

/** `key` names the title, and the episode where there is one. */
export function recallReleases(key: string, storage = store()): ReleaseMemory {
  try {
    const kept = JSON.parse(
      storage?.getItem(PREFIX + key) ?? 'null',
    ) as Partial<ReleaseMemory> | null;
    return {
      chosen: typeof kept?.chosen === 'string' ? kept.chosen : undefined,
      left: Array.isArray(kept?.left) ? kept.left.filter((one) => typeof one === 'string') : [],
    };
  } catch {
    return { left: [] };
  }
}

export function rememberReleases(key: string, memory: ReleaseMemory, storage = store()): void {
  try {
    storage?.setItem(PREFIX + key, JSON.stringify(memory));
  } catch (error) {
    // A private window or a full store: the pick holds for this player, just not past a reload.
    console.warn('Couldn’t keep this title’s release choice for a reload.', error);
  }
}
