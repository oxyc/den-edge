import { ContentAuthority } from '../src/lib/contentAuthority';
import type { ContentServiceClientPort } from '../src/lib/libraryServiceFactory';
import type { ContentRequest, ContentResultFor } from '../src/lib/contentServiceProtocol';

/** Test-only in-page authority for focused component fixtures; production always uses the DedicatedWorker. */
export function fixtureContentService(
  keys: { tmdb: string; omdb?: string; warnings?: string; atlas?: string } = {
    tmdb: 'fixture-key',
  },
): ContentServiceClientPort {
  const authority = new ContentAuthority({
    tmdb: () => keys.tmdb,
    omdb: () => keys.omdb,
    contentWarnings: () => keys.warnings,
    atlas: () => keys.atlas,
  });
  return {
    query<Request extends ContentRequest>(request: Request, signal?: AbortSignal) {
      return authority.query(request, signal ?? new AbortController().signal) as Promise<
        ContentResultFor<Request>
      >;
    },
    onStatus: () => () => {},
  };
}
