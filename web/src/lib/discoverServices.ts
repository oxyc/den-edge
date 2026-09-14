import { findAddon, findAtlas, REEL, SCOUT, type Addon } from './scout';
import { findRemux } from './remux';
import type { Routes } from './routes';

/** Publish independent services as they answer. A playback route can be unreachable while the
 * same-origin discovery addons work. Disposal also prevents old settings overwriting new ones. */
export function discoverServices(
  installed: string[],
  routes: Routes,
  publish: {
    /** Omitted by a guest: with no receiver the probe is never issued, so the playback services cannot be
     * discovered at all. Stronger than relying on an empty plugin list — `findRemux` reads the routes
     * table and never consults plugins. */
    scout?: (value: Addon | null) => void;
    atlas: (value: Addon | null) => void;
    reel: (value: Addon | null) => void;
    remux?: (value: string | null) => void;
  },
): () => void {
  let current = true;
  const accept = <T>(work: Promise<T | null>, receive: (value: T | null) => void) => {
    void work.then(
      (value) => {
        if (current) receive(value);
      },
      () => {
        if (current) receive(null);
      },
    );
  };
  if (publish.scout) accept(findAddon(installed, routes, SCOUT), publish.scout);
  accept(findAtlas(installed, routes), publish.atlas);
  accept(findAddon(installed, routes, REEL), publish.reel);
  if (publish.remux) accept(findRemux(routes.remux ?? []), publish.remux);
  return () => {
    current = false;
  };
}
