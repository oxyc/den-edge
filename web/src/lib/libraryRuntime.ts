import { ContentAuthority, WorkerContentCredentials } from './contentAuthority';
import { ContentServiceCore } from './contentServiceCore';
import { LibraryServiceCore } from './libraryServiceCore';
import { openLibraryServiceAuthority } from './libraryServiceRuntimeAuthority';

/**
 * The complete, environment-neutral library runtime. A browser page and a SharedWorker construct this exact class;
 * only the message edge around it differs. One instance owns one library actor, one content authority, and at most
 * one live LibraryLog.
 */
export class LibraryRuntime {
  readonly contentCredentials = new WorkerContentCredentials();
  readonly contentAuthority = new ContentAuthority(this.contentCredentials);
  readonly library = new LibraryServiceCore((request, progress) =>
    openLibraryServiceAuthority(
      request,
      undefined,
      this.contentCredentials,
      this.contentAuthority,
      progress,
    ),
  );
  readonly content = new ContentServiceCore(this.contentAuthority);

  async close(): Promise<void> {
    await Promise.allSettled([this.library.close(), this.content.close()]);
  }
}
