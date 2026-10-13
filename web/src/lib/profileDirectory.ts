import { syncPolicy } from './syncCore';
import type { Stamp } from './wire';

export type ProfileRole = 'owner' | 'kid' | 'adult';

export interface ProfileDirectoryDocument {
  readonly format: 4;
  readonly kind: 'profiles';
  readonly schema: 1;
  readonly owner: string;
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

/** The shared den-core contract is the sole authority for directory shape and cross-entry invariants. */
export const validateProfileDirectory = (document: unknown): ProfileDirectoryDocument =>
  syncPolicy<ProfileDirectoryDocument>({ op: 'profiles_validate', document });
