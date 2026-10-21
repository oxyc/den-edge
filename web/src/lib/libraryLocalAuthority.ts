/** Durable identity of local authoritative state. Derived caches compare against it before serving data. */
export const LIBRARY_LOCAL_AUTHORITY = 'local-authority.v1';

export interface LibraryLocalAuthorityIdentity {
  generation: string;
  head: number;
  authorityRevision: string;
  rowsVersion: number;
}

export const libraryLocalAuthorityRevision = (
  head: number,
  rowsVersion: number,
  stamp: unknown,
): string => JSON.stringify([head, rowsVersion, stamp]);

export const validLibraryLocalAuthorityIdentity = (
  value: unknown,
): value is LibraryLocalAuthorityIdentity => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const held = value as Partial<LibraryLocalAuthorityIdentity>;
  return (
    typeof held.generation === 'string' &&
    held.generation.length > 0 &&
    Number.isSafeInteger(held.head) &&
    held.head! >= 0 &&
    typeof held.authorityRevision === 'string' &&
    Number.isSafeInteger(held.rowsVersion) &&
    held.rowsVersion! >= 0
  );
};
