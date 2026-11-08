import type { JoinLibrary } from './browserHousehold';
import type { LibraryJoinPresentationLease } from './libraryJoinPresentation';
import { links, type Link, type Links } from './links.svelte';

type RecoveryLinks = Pick<Links, 'recoveryCandidate' | 'reconcileCommitted' | 'makeCurrent'>;

/**
 * Adopt a recovered library for one exact Settings presentation. The join owns durable reconciliation; only the
 * still-current presentation may select the committed link and navigate into it.
 */
export async function adoptRecoveredLibrary(
  libraryKey: string,
  presentation: LibraryJoinPresentationLease,
  onjoin?: JoinLibrary,
  store: RecoveryLinks = links,
  open: (link: Link) => void = () => location.assign('/'),
): Promise<boolean> {
  if (!presentation.isCurrent()) return false;
  const target = store.recoveryCandidate(libraryKey);
  if (
    onjoin &&
    (await onjoin(libraryKey, {
      presentation,
      link: {
        inboxKey: target.inboxKey,
        name: target.name ?? 'a recovery code',
        linkKey: target.linkKey,
        ...(target.deviceId ? { deviceId: target.deviceId } : {}),
        ...(target.recovered ? { recovered: true } : {}),
        ...(target.linkedAt !== undefined ? { linkedAt: target.linkedAt } : {}),
      },
    })) !== 'joined'
  )
    return false;
  const committed = store.reconcileCommitted(target, libraryKey);
  if (!presentation.isCurrent() || !committed) return false;
  store.makeCurrent(committed.inboxKey);
  open(committed);
  return true;
}
