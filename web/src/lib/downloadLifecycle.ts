import type { DownloadStatus } from './downloadCoordinator';
import type { DownloadViewItem } from './libraryServiceProtocol';

/**
 * A row whose provider work may still be holding a download slot. Internal durable states use underscores while the
 * presentation protocol uses hyphens; keeping both spellings here gives mutation authority and UI one contract.
 */
export function downloadIsInFlight(
  state: DownloadStatus['state'] | DownloadViewItem['status']['state'],
): boolean {
  return (
    state === 'starting' ||
    state === 'fetching' ||
    state === 'not_started' ||
    state === 'not-started' ||
    state === 'paused'
  );
}
