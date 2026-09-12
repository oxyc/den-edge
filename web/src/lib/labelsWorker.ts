// Reads atlas's labels file on a thread of its own and answers the page's lookups from it, so the page never stalls
// on a 9 MB parse. The file itself comes from the browser's cache on every visit but the first (atlasIndex.ts).

import type { Labels } from './atlasIndex';
import { loadLabels } from './labelsFile';

export interface LookupRequest {
  id: number;
  /** Absolute: a worker resolves a relative URL against its own script, not the page. */
  base: string;
  keys: string[];
}

export interface LookupAnswer {
  id: number;
  /** The keys the file labels, with their labels; null when atlas couldn't be reached. */
  entries: [string, Labels][] | null;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<LookupRequest>) => void) | null;
  postMessage(answer: LookupAnswer): void;
};

/** One load per atlas for the worker's life; a failed one is dropped, so the next lookup asks again. */
const loads = new Map<string, Promise<Map<string, Labels> | null>>();

scope.onmessage = async ({ data: { id, base, keys } }) => {
  let load = loads.get(base);
  if (!load) {
    load = loadLabels(base, fetch);
    loads.set(base, load);
  }
  const all = await load;
  if (!all) loads.delete(base);
  scope.postMessage({
    id,
    entries: all
      ? keys.flatMap((key): [string, Labels][] => {
          const labels = all.get(key);
          return labels ? [[key, labels]] : [];
        })
      : null,
  });
};
