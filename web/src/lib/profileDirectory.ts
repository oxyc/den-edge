import { syncPolicy } from './syncCore';
import type { Stamp } from './wire';

export type ProfileRole = 'owner' | 'kid' | 'adult';

export interface ProfileDirectoryDocument {
  readonly format: 4;
  readonly kind: 'profiles';
  readonly schema: 1;
  readonly owner: string;
  /** Immutable proof that this directory was committed with its initial Owner profile. */
  readonly migration: {
    readonly version: 1;
    readonly attempt: string;
    readonly source: { readonly generation: number; readonly head: string };
    readonly backup: { readonly id: string; readonly digest: string };
    readonly ownerProfile: string;
    readonly ownerHead: string;
  };
  readonly profiles: Record<
    string,
    {
      readonly id: string;
      readonly role: ProfileRole;
      readonly display: {
        readonly value: { readonly name: string; readonly avatar?: string };
        readonly at: Stamp;
      };
      readonly library: {
        readonly value: { readonly keyVersion: number; readonly key: string };
        readonly at: Stamp;
      };
      readonly policy: {
        readonly value: {
          readonly maximumAge: number | null;
          readonly unknownRatings: 'allow' | 'block';
          readonly [extension: string]: unknown;
        };
        readonly at: Stamp;
      };
      readonly deleted: { readonly value: boolean; readonly at: Stamp };
      readonly [extension: string]: unknown;
    }
  >;
  readonly [extension: string]: unknown;
}

/**
 * Validate a directory read from committed household state. `stored` is deliberately fixed here: constructor
 * input may omit migration evidence, but a row/cache/session may never interpret that input as a committed split.
 */
export const validateStoredProfileDirectory = (document: unknown): ProfileDirectoryDocument =>
  syncPolicy<ProfileDirectoryDocument>({ op: 'profiles_validate', document, stored: true });
