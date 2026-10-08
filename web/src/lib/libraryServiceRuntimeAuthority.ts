import { openClockStore } from './clockStore';
import { DownloadServiceRuntime } from './downloadServiceRuntime';
import { LibraryLogAuthority } from './libraryLogAuthority';
import { DurableOperationAuthority } from './libraryOperationAuthority';
import type { LibraryServiceHello } from './libraryServiceProtocol';
import type { LibraryServiceAuthority } from './libraryServiceCore';
import { libraryVault, type Vault } from './localVault';
import { LibraryLog } from './log';
import {
  libraryLogMaintenance,
  librarySimklDelivery,
  ScheduledLibraryServiceAuthority,
} from './libraryServiceScheduledAuthority';

/**
 * Open the single production authority for one service instance. Both transports call this exact boundary: the
 * transport affects scheduling only, never storage, command semantics, or the rendered projections.
 */
export async function openLibraryServiceAuthority(
  request: LibraryServiceHello,
  vault: Vault | null = libraryVault,
): Promise<LibraryServiceAuthority | null> {
  if (!vault) return null;

  // Seed the durable clock before opening the log so a failed clock cannot leave an opened log behind. Durable
  // clock state wins inside openClockStore; the page-provided value is migration input only.
  const clock = await openClockStore(vault, { legacy: request.legacyClock });
  const log =
    request.mode === 'local'
      ? await LibraryLog.openLocal(request.libraryKey, vault)
      : await LibraryLog.open(request.libraryKey, undefined, undefined, vault);
  if (!log) return null;
  const downloads = new DownloadServiceRuntime(log, clock, () => {});
  const logAuthority = new LibraryLogAuthority(log, clock, {
    mode: request.mode,
    downloads: downloads.coordinator,
    libraryKey: request.libraryKey,
    vault,
    refreshDownloads: (target) => downloads.refresh(target),
    downloadArtwork: (target) => downloads.artwork(target),
  });
  return new ScheduledLibraryServiceAuthority(
    new DurableOperationAuthority(logAuthority, log),
    libraryLogMaintenance(log, clock, request.mode),
    { background: downloads },
    librarySimklDelivery(log, clock),
  );
}
