import type { MediaType } from './library';

const POINTER_PREFIX = 'den.hero-lead.current.v1';
const LEAD_KEY = /^den\.hero-lead\.v1\.[0-9a-f]{64}\.(?:fresh\.)?(?:all|movie|tv)$/;

type LeadStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;
type Pointer = { identity: string; key: string };

const pointerKey = (facet: MediaType | null, fresh: boolean) =>
  `${POINTER_PREFIX}.${fresh ? 'fresh.' : ''}${facet ?? 'all'}`;

const validKey = (key: string, facet: MediaType | null, fresh: boolean) =>
  LEAD_KEY.test(key) && key.endsWith(`.${fresh ? 'fresh.' : ''}${facet ?? 'all'}`);

export function pointedHeroLeadKey(
  identity: string,
  facet: MediaType | null,
  fresh: boolean,
  storage: LeadStorage,
): string | null {
  try {
    const raw = storage?.getItem(pointerKey(facet, fresh));
    const pointer = raw ? (JSON.parse(raw) as Partial<Pointer> | null) : null;
    return pointer?.identity === identity &&
      typeof pointer.key === 'string' &&
      validKey(pointer.key, facet, fresh)
      ? pointer.key
      : null;
  } catch {
    return null;
  }
}

export function keepHeroLeadPointer(
  identity: string,
  facet: MediaType | null,
  fresh: boolean,
  key: string,
  storage: LeadStorage,
): void {
  if (!storage || !validKey(key, facet, fresh)) return;
  const name = pointerKey(facet, fresh);
  try {
    const raw = storage.getItem(name);
    const previous = raw ? (JSON.parse(raw) as Partial<Pointer> | null) : null;
    if (
      typeof previous?.identity === 'string' &&
      previous.identity !== identity &&
      typeof previous.key === 'string' &&
      validKey(previous.key, facet, fresh)
    )
      storage.removeItem(previous.key);
  } catch {
    // An unreadable pointer names no validated lead to remove; replacing the pointer itself remains safe.
  }
  storage.setItem(name, JSON.stringify({ identity, key } satisfies Pointer));
}

export function removeHeroLeadPointer(
  identity: string,
  facet: MediaType | null,
  fresh: boolean,
  key: string,
  storage: LeadStorage,
): void {
  if (pointedHeroLeadKey(identity, facet, fresh, storage) === key)
    storage?.removeItem(pointerKey(facet, fresh));
}

/** Remove every plaintext pointer and lead belonging to a library whose key is being forgotten or replaced. */
export function forgetHeroLeadPointers(
  identity: string,
  storage: LeadStorage = globalThis.localStorage,
): void {
  for (const facet of [null, 'movie', 'tv'] as const) {
    for (const fresh of [false, true]) {
      const name = pointerKey(facet, fresh);
      try {
        const raw = storage?.getItem(name);
        if (!raw) continue;
        const pointer = JSON.parse(raw) as Partial<Pointer> | null;
        if (pointer?.identity !== identity) continue;
        storage?.removeItem(name);
        if (typeof pointer.key === 'string' && LEAD_KEY.test(pointer.key))
          storage?.removeItem(pointer.key);
      } catch {
        // A malformed pointer can never be used and may contain an old plaintext identity.
        storage?.removeItem(name);
      }
    }
  }
}
