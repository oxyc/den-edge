import type { ProfileDirectoryDocument } from './profileDirectory';
import { syncPolicy } from './syncCore';
import type { Stamp } from './wire';

export interface KidTitleApprovalsDocument {
  readonly format: 4;
  readonly kind: 'kid-title-approvals';
  readonly schema: 1;
  readonly kid: string;
  readonly approvals: Record<
    string,
    {
      readonly value: 'allow' | 'tombstone';
      readonly at: Stamp;
      readonly [extension: string]: unknown;
    }
  >;
  readonly [extension: string]: unknown;
}

export const kidApprovalName = (kid: string): string => `kid-title-approvals:${kid}`;

export function validateKidTitleApprovals(
  document: unknown,
  directory: ProfileDirectoryDocument,
): KidTitleApprovalsDocument {
  const kid =
    typeof document === 'object' && document !== null && 'kid' in document
      ? (document as { kid?: unknown }).kid
      : null;
  if (typeof kid !== 'string') throw new Error('Kid approval document has no Kid');
  return syncPolicy<KidTitleApprovalsDocument>({
    op: 'kid_title_approvals_validate',
    logicalName: kidApprovalName(kid),
    document,
    directory,
  });
}
