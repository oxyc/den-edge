import { openClockStore } from './clockStore';
import type { ContentCredentialSource } from './contentAuthority';
import { DownloadServiceRuntime, type DownloadContent } from './downloadServiceRuntime';
import { LibraryLogAuthority } from './libraryLogAuthority';
import { DurableOperationAuthority } from './libraryOperationAuthority';
import type { LibraryServiceHello } from './libraryServiceProtocol';
import type { LibraryAuthorityEvent, LibraryServiceAuthority } from './libraryServiceCore';
import { libraryVault, type Vault } from './localVault';
import { LibraryLog } from './log';
import { readApiKey } from './prefs';
import { useLibraryRelayMembership } from './relayFetch';
import {
  libraryLogMaintenance,
  librarySimklDelivery,
  ScheduledLibraryServiceAuthority,
} from './libraryServiceScheduledAuthority';
import { tmdbKeyOf } from './tmdb';

export interface LibraryContentCredentialSink {
  bind(source: ContentCredentialSource): () => void;
}

/** Release a library's private provider view exactly when its authority closes. */
class CredentialBoundLibraryAuthority implements LibraryServiceAuthority {
  #closed = false;

  constructor(
    private readonly authority: LibraryServiceAuthority,
    private readonly releaseCredentials: () => void,
  ) {}

  get generation(): string | null {
    return this.authority.generation;
  }

  select: LibraryServiceAuthority['select'] = (selection) => this.authority.select(selection);
  command: LibraryServiceAuthority['command'] = (command, operationId) =>
    this.authority.command(command, operationId);
  query: LibraryServiceAuthority['query'] = (query) => this.authority.query(query);
  task: LibraryServiceAuthority['task'] = (task, operationId) =>
    this.authority.task(task, operationId);
  observe: LibraryServiceAuthority['observe'] = (observation) =>
    this.authority.observe(observation);

  listen(listener: (event: LibraryAuthorityEvent) => void): () => void {
    return this.authority.listen?.(listener) ?? (() => {});
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.releaseCredentials();
    await this.authority.close?.();
  }
}

/**
 * Open the single production authority for one service instance. Both transports call this exact boundary: the
 * transport affects scheduling only, never storage, command semantics, or the rendered projections.
 */
export async function openLibraryServiceAuthority(
  request: LibraryServiceHello,
  providedVault: Vault | null | undefined,
  contentCredentials: LibraryContentCredentialSink | undefined,
  content: DownloadContent,
): Promise<LibraryServiceAuthority | null> {
  const vault = providedVault === undefined ? libraryVault : providedVault;
  if (!vault) return null;

  // Seed the durable clock before opening the log so a failed clock cannot leave an opened log behind. Durable
  // clock state wins inside openClockStore; the page-provided value is migration input only.
  const clock = await openClockStore(vault, { legacy: request.legacyClock });
  const log =
    request.mode === 'local'
      ? await LibraryLog.openLocal(request.libraryKey, vault)
      : await LibraryLog.open(request.libraryKey, undefined, undefined, vault);
  if (!log) return null;
  const downloads = new DownloadServiceRuntime(log, clock, () => {}, content);
  const logAuthority = new LibraryLogAuthority(log, clock, {
    mode: request.mode,
    downloads: downloads.coordinator,
    libraryKey: request.libraryKey,
    vault,
    refreshDownloads: (target) => downloads.refresh(target),
    downloadArtwork: (target) => downloads.artwork(target),
  });
  const authority = new ScheduledLibraryServiceAuthority(
    new DurableOperationAuthority(logAuthority, log),
    libraryLogMaintenance(log, clock, request.mode),
    { background: downloads },
    librarySimklDelivery(log, clock),
  );
  if (!contentCredentials) return authority;
  let credentialsCurrent = true;
  let releaseMembership = () => {};
  let membershipReady: Promise<void> | undefined;
  const ready = () =>
    (membershipReady ??= log.relayMembership().then((membership) => {
      if (credentialsCurrent && membership)
        releaseMembership = useLibraryRelayMembership(membership);
    }));
  const releaseCredentials = contentCredentials.bind({
    ready,
    tmdb: () => tmdbKeyOf(log.settings('keys')),
    omdb: () => readApiKey(log.settings('keys'), 'omdb'),
    contentWarnings: () => readApiKey(log.settings('keys'), 'doesthedogdie'),
  });
  return new CredentialBoundLibraryAuthority(authority, () => {
    credentialsCurrent = false;
    releaseCredentials();
    releaseMembership();
  });
}
