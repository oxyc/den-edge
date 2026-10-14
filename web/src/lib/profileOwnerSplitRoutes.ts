const ID = '[0-9a-f]{32}';

export type OwnerSplitWorkerRoute =
  | { readonly kind: 'capability' }
  | { readonly kind: 'source' }
  | { readonly kind: 'open' }
  | { readonly kind: 'lookup' | 'abort'; readonly attempt: string }
  | {
      readonly kind: 'backup' | 'rows' | 'commit' | 'restore' | 'retire-candidate';
      readonly attempt: string;
    };

/** Exact den-edge #443/#449 route surface. Raw strings with queries, fragments or dot segments never classify. */
export function ownerSplitWorkerRoute(
  householdId: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
): OwnerSplitWorkerRoute | null {
  if (!new RegExp(`^${ID}$`).test(householdId)) return null;
  if (method === 'GET' && path === `/lib/${householdId}/profile-capability`)
    return { kind: 'capability' };
  if (method === 'GET' && path === `/lib/${householdId}/profile-migration/source`)
    return { kind: 'source' };
  if (method === 'POST' && path === `/lib/${householdId}/profile-migration`)
    return { kind: 'open' };
  const match = new RegExp(
    `^/lib/${householdId}/profile-migration/(${ID})(?:/(backup|rows|commit|restore|retire-candidate))?$`,
  ).exec(path);
  if (!match) return null;
  const attempt = match[1]!;
  const action = match[2];
  if (action === undefined) {
    if (method === 'GET') return { kind: 'lookup', attempt };
    if (method === 'DELETE') return { kind: 'abort', attempt };
    return null;
  }
  // The backup is created by den-edge when it opens the attempt. A client may only read it, so the idempotent
  // `POST …/backup` compatibility route is deliberately not reachable from Web.
  if (action === 'backup' && method === 'GET') return { kind: 'backup', attempt };
  if (
    method === 'POST' &&
    (action === 'rows' ||
      action === 'commit' ||
      action === 'restore' ||
      action === 'retire-candidate')
  )
    return { kind: action, attempt };
  return null;
}

/** Headers for the first Owner-library write: candidate token, but an already-authorized household member proof. */
export function ownerSplitCandidateWriteHeaders(
  household: { readonly id: string; readonly member: string },
  candidate: { readonly token: string },
): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-den-library-token': candidate.token,
    'x-den-library-member': `${household.id}:${household.member}`,
    'x-den-wire': '4',
    'x-den-wire-min': '4',
    'x-den-generation': '0',
  };
}
