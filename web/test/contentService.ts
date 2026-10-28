import { ContentAuthority } from '../src/lib/contentAuthority';
import { setContentServiceContext } from '../src/lib/contentContext';
import {
  ContentServiceClient,
  type ContentServiceClientPort,
  type ContentServiceTransport,
} from '../src/lib/contentServiceClient';
import { ContentServiceCore } from '../src/lib/contentServiceCore';
import type { ContentServiceServerMessage } from '../src/lib/contentServiceProtocol';

/**
 * Test-only in-page content service for focused component fixtures. Production runs the same Core in a
 * DedicatedWorker; here every message is still cloned both ways, as `postMessage` would, so what the page sees is
 * what crosses the Worker boundary.
 */
export function fixtureContentService(
  keys: { tmdb: string; omdb?: string; warnings?: string; atlas?: string } = {
    tmdb: 'fixture-key',
  },
): ContentServiceClientPort {
  let atlas: string | undefined = keys.atlas;
  const core = new ContentServiceCore(
    new ContentAuthority({
      tmdb: () => keys.tmdb,
      omdb: () => keys.omdb,
      contentWarnings: () => keys.warnings,
      atlas: () => atlas,
      configureAtlas: (base) => (atlas = base?.replace(/\/$/, '') ?? undefined),
    }),
  );
  const listeners = new Set<(message: ContentServiceServerMessage) => void>();
  const deliver = (messages: ContentServiceServerMessage[]) => {
    for (const message of structuredClone(messages))
      for (const listener of listeners) listener(message);
  };
  core.listen(deliver);
  const transport: ContentServiceTransport = {
    send: (message) => void core.dispatch(structuredClone(message)).then(deliver),
    listen: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => void core.close(),
  };
  return new ContentServiceClient(transport, 'fixture');
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
