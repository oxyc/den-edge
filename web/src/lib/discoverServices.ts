import { findAddon, findAtlas, REEL, SCOUT, type Addon } from './scout';
import { findRemux } from './remux';
import type { Routes } from './routes';

/** Publish independent services as they answer. A playback route can be unreachable while the
 * same-origin discovery addons work. Disposal also prevents old settings overwriting new ones. */
export function discoverServices(installed: string[], routes: Routes, publish: {
  scout: (value: Addon | null) => void;
  atlas: (value: Addon | null) => void;
  reel: (value: Addon | null) => void;
  remux: (value: string | null) => void;
}): () => void {
  let current = true;
  const accept = <T>(work: Promise<T | null>, receive: (value: T | null) => void) => {
    void work.then((value) => { if (current) receive(value); }, () => { if (current) receive(null); });
  };
  accept(findAddon(installed, routes, SCOUT), publish.scout);
  accept(findAtlas(installed, routes), publish.atlas);
  accept(findAddon(installed, routes, REEL), publish.reel);
  accept(findRemux(routes.remux ?? []), publish.remux);
  return () => { current = false; };
}
