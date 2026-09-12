// atlas's labels file, read into a lookup by `type:id`. Shared by the page and the worker that reads it off the
// page's thread (labelsWorker.ts): about 9 MB of JSON, a long task on a phone.

import type { Labels } from './atlasIndex';

interface LabelsFile {
  records?: {
    tmdbId?: unknown;
    mediaType?: unknown;
    primaryGenre?: unknown;
    animated?: unknown;
    subgenres?: unknown;
    moods?: unknown;
  }[];
}

async function getJson<T>(url: string, fetchImpl: typeof fetch): Promise<T | null> {
  try {
    const res = await fetchImpl(url);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null; // atlas out of reach: the billboard falls back on what TMDB said
  }
}

/** The labels file's `{label, confidence}` list as `[label, confidence]` pairs, as atlas's own answers give them. */
function pairs(list: unknown): [string, number][] {
  return Array.isArray(list)
    ? list.flatMap((entry: { label?: unknown; confidence?: unknown } | null) =>
        typeof entry?.label === 'string' && typeof entry.confidence === 'number'
          ? [[entry.label, entry.confidence] as [string, number]]
          : [],
      )
    : [];
}

/** Every title's labels in the dataset atlas serves at `base`; null when atlas can't be reached. */
export async function loadLabels(
  base: string,
  fetchImpl: typeof fetch,
): Promise<Map<string, Labels> | null> {
  const descriptor = await getJson<{ labels?: { url?: unknown } }>(
    `${base}/dataset.json`,
    fetchImpl,
  );
  const url = descriptor?.labels?.url;
  if (typeof url !== 'string') return null;
  // The descriptor names atlas's own address; this page asks atlas under its own origin, at `base`.
  const blob = new URL(url, 'https://atlas.invalid');
  const file = await getJson<LabelsFile>(`${base}${blob.pathname}${blob.search}`, fetchImpl);
  if (!Array.isArray(file?.records)) return null;
  const all = new Map<string, Labels>();
  for (const record of file.records) {
    const type =
      record.mediaType === 'movie'
        ? 'movie'
        : record.mediaType === 'tv' || record.mediaType === 'series'
          ? 'tv'
          : null;
    if (!type || typeof record.tmdbId !== 'number') continue;
    const key = `${type}:${record.tmdbId}`;
    if (all.has(key)) continue; // as atlas reads the file: the first row wins a duplicate
    all.set(key, {
      primaryGenre: typeof record.primaryGenre === 'string' ? record.primaryGenre : undefined,
      animated: record.animated === true,
      subgenres: pairs(record.subgenres),
      moods: pairs(record.moods),
    });
  }
  return all;
}
