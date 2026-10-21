import type { LibraryQuery, RetainedBillboard } from './libraryServiceProtocol';
import { isRetainedBillboard } from './libraryServiceProtocolCodec';

export const RETAINED_SERVICES = 'services.v1';
export const RETAINED_HOME_SHELVES = 'home.shelves.v1';
export const RETAINED_PREFERENCE_SEED = 'preferences.seed.v1';

export const retainedBillboardName = (
  scope: Extract<LibraryQuery, { kind: 'retained.billboard.get' }>['scope'],
) =>
  scope.kind === 'personal'
    ? `billboard.personal.v1.${scope.fresh ? 'fresh.' : ''}${scope.facet ?? 'all'}`
    : `billboard.v4.${scope.fresh ? 'fresh.' : ''}${scope.facet ?? 'all'}`;

export const retainedBillboardValue = (
  scope: Extract<LibraryQuery, { kind: 'retained.billboard.get' }>['scope'],
  stored: unknown,
): RetainedBillboard | null => {
  const candidate =
    scope.kind === 'shared'
      ? { kind: 'shared' as const, titles: stored }
      : stored && typeof stored === 'object' && !Array.isArray(stored)
        ? {
            kind: 'personal' as const,
            at: (stored as { at?: unknown }).at,
            titles: (stored as { titles?: unknown }).titles,
          }
        : null;
  return isRetainedBillboard(candidate) && candidate.kind === scope.kind ? candidate : null;
};

export const storedBillboardValue = (value: RetainedBillboard): unknown =>
  value.kind === 'shared' ? value.titles : { at: value.at, titles: value.titles };
