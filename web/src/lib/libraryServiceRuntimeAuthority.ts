import { openClockStore } from './clockStore';
import type { ContentCredentialSource, ContentReader } from './contentAuthority';
import { DownloadServiceRuntime, type DownloadContent } from './downloadServiceRuntime';
import { LibraryLogAuthority } from './libraryLogAuthority';
import { DurableOperationAuthority } from './libraryOperationAuthority';
import type { LibraryServiceHello } from './libraryServiceProtocol';
import {
  LibraryServiceAuthorityError,
  type LibraryAuthorityEvent,
  type LibraryServiceAuthority,
} from './libraryServiceCore';
import { libraryVault, type Vault } from './localVault';
import { LibraryLog, LibraryUpdateRequiredError, type DeferredDelivery } from './log';
import { readApiKey } from './prefs';
import { useLibraryRelayMembership } from './relayFetch';
import { startupMark } from './startupTiming';
import { resetLibraryStartupMetrics } from './libraryStartupMetrics';
import { openFinishedLibraryViewAuthority, type NarrowEdit } from './finishedLibraryViewAuthority';
import {
  libraryLogMaintenance,
  librarySimklDelivery,
  ScheduledLibraryServiceAuthority,
} from './libraryServiceScheduledAuthority';
import { tmdbKeyOf } from './workerTmdbProvider';

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
  content: DownloadContent & Pick<ContentReader, 'title'>,
  progress?: (progress: number) => void,
): Promise<LibraryServiceAuthority | null> {
  const vault = providedVault === undefined ? libraryVault : providedVault;
  if (!vault) return null;

  // Seed the durable clock before opening the log so a failed clock cannot leave an opened log behind. Durable
  // clock state wins inside openClockStore; the page-provided value is migration input only.
  resetLibraryStartupMetrics();
  startupMark('log open requested', `${request.mode}, wire ${request.wire}`);
  const clock = await openClockStore(vault, { legacy: request.legacyClock });
  const openFull = async (): Promise<LibraryServiceAuthority | null> => {
    const openingAt = performance.now();
    let log: LibraryLog | null;
    try {
      log =
        request.mode === 'local'
          ? await LibraryLog.openLocal(request.libraryKey, vault, undefined, request.wire)
          : await LibraryLog.open(request.libraryKey, undefined, undefined, vault, request.wire);
    } catch (error) {
      if (error instanceof LibraryUpdateRequiredError)
        throw new LibraryServiceAuthorityError({
          code: 'update-required',
          message: error.message,
          retryable: false,
          requiredWire: error.requiredWire,
        });
      throw error;
    }
    startupMark(
      'log opened',
      `${!log ? 'unavailable' : request.mode === 'local' ? 'local' : log.fromCache ? 'from kept copy' : 'from den-edge'} in ${Math.round(performance.now() - openingAt)}ms`,
    );
    if (!log) return null;
    // Every Worker-owned relay client uses relayFetch, not only ContentAuthority. Install the bounded membership
    // before the authority can answer `ready`: a source query that already carries an IMDb id goes straight from
    // DownloadServiceRuntime to Scout and must not depend on an unrelated TMDB/Atlas request having initialized it.
    let releaseMembership = () => {};
    const membershipReady = log.relayMembership().then((membership) => {
      if (membership) releaseMembership = useLibraryRelayMembership(membership);
    });
    const downloads = new DownloadServiceRuntime(log, clock, () => {}, content);
    const logAuthority = new LibraryLogAuthority(log, clock, {
      mode: request.mode,
      downloads: downloads.coordinator,
      content,
      libraryKey: request.libraryKey,
      vault,
      refreshDownloads: (target) => downloads.refresh(target),
      downloadArtwork: (target) => downloads.artwork(target),
    });
    const authority = new ScheduledLibraryServiceAuthority(
      new DurableOperationAuthority(logAuthority, log),
      libraryLogMaintenance(log, request.mode),
      { background: downloads },
      librarySimklDelivery(log, clock),
    );
    let releaseCredentials = () => {};
    if (contentCredentials)
      releaseCredentials = contentCredentials.bind({
        ready: () => membershipReady,
        tmdb: () => tmdbKeyOf(log.settings('keys')),
        omdb: () => readApiKey(log.settings('keys'), 'omdb'),
        contentWarnings: () => readApiKey(log.settings('keys'), 'doesthedogdie'),
      });
    await membershipReady;
    return new CredentialBoundLibraryAuthority(authority, () => {
      releaseCredentials();
      releaseMembership();
    });
  };

  // One edit of `names`, on a log of those documents alone (`LibraryLog.openNarrow`): the same authority, receipts and
  // sending as the whole log's, without reading the rest of the library.
  const openNarrow = async (names: readonly string[]): Promise<NarrowEdit | null> => {
    if (request.mode !== 'online') return null;
    const log = await LibraryLog.openNarrow(
      request.libraryKey,
      names,
      undefined,
      vault,
      request.wire,
    );
    if (!log) return null;
    const downloads = new DownloadServiceRuntime(log, clock, () => {}, content);
    const logAuthority = new LibraryLogAuthority(log, clock, {
      mode: request.mode,
      downloads: downloads.coordinator,
      content,
      libraryKey: request.libraryKey,
      vault,
    });
    let settle!: (outcome: DeferredDelivery['outcome']) => void;
    const settled = new Promise<DeferredDelivery['outcome']>((resolve) => (settle = resolve));
    const announce = log.onDeferred;
    log.onDeferred = (delivery) => {
      announce?.(delivery);
      settle(delivery.outcome);
    };
    return {
      authority: new DurableOperationAuthority(logAuthority, log),
      settled,
      // A narrow log opens with no kept work (`openNarrow`), so whatever is kept now is this edit's.
      sending: () => log.pendingActions > 0,
    };
  };

  const cached = await openFinishedLibraryViewAuthority(
    request,
    vault,
    openFull,
    content,
    undefined,
    progress,
    openNarrow,
  );
  if (!cached) return openFull();
  const releaseMembership = useLibraryRelayMembership(cached.membership);
  const releaseCredentials = contentCredentials?.bind({
    ready: () => Promise.resolve(),
    tmdb: () => undefined,
    omdb: () => undefined,
    contentWarnings: () => undefined,
  });
  startupMark('log opened', 'from finished views; document log remains lazy');
  return new CredentialBoundLibraryAuthority(cached.authority, () => {
    releaseCredentials?.();
    releaseMembership();
  });
}
