import { ContentAuthority } from '../src/lib/contentAuthority';
import { setContentServiceContext } from '../src/lib/contentContext';
import type { ContentServiceClientPort } from '../src/lib/libraryServiceFactory';
import type { ContentRequest, ContentResultFor } from '../src/lib/contentServiceProtocol';

/** Test-only in-page authority for focused component fixtures; production always uses the DedicatedWorker. */
export function fixtureContentService(
  keys: { tmdb: string; omdb?: string; warnings?: string; atlas?: string } = {
    tmdb: 'fixture-key',
  },
): ContentServiceClientPort {
  let atlas: string | undefined = keys.atlas;
  const authority = new ContentAuthority({
    tmdb: () => keys.tmdb,
    omdb: () => keys.omdb,
    contentWarnings: () => keys.warnings,
    atlas: () => atlas,
    configureAtlas: (base) => (atlas = base?.replace(/\/$/, '') ?? undefined),
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

/** Install the in-page authority for a standalone Svelte fixture's entire descendant tree. */
export function fixtureContentServiceContext(
  keys: { tmdb: string; omdb?: string; warnings?: string; atlas?: string } = {
    tmdb: 'fixture-key',
  },
): ContentServiceClientPort {
  const content = fixtureContentService(keys);
  setContentServiceContext(content);
  return content;
}
