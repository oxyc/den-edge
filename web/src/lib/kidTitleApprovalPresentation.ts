import type { KidTitleApprovalChangeResult } from './profileModeCoordinator.svelte';

/** Publish a completed title-access result only into the exact presentation that started it. */
export function finishKidTitleApprovalPresentation(
  expected: object,
  current: object | null,
  result: KidTitleApprovalChangeResult,
  onSaved: () => void,
): KidTitleApprovalChangeResult {
  if (current !== expected) return { outcome: 'superseded' };
  if (result.outcome === 'saved') onSaved();
  return result;
}
