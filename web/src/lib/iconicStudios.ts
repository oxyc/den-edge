import type { MediaType } from './library';
import { relayFetch } from './relayFetch';

export interface IconicStudio {
  id: string;
  name: string;
}

/** Atlas's curated studios for one title. Missing/old indexes quietly leave the TMDB company text in place. */
export function parseIconicStudios(body: unknown): IconicStudio[] {
  if (!body || typeof body !== 'object') return [];
  const studios = (body as { studios?: unknown }).studios;
  if (!Array.isArray(studios)) return [];
  const seen = new Set<string>();
  return studios.flatMap((value): IconicStudio[] => {
    if (!value || typeof value !== 'object') return [];
    const { id, name } = value as { id?: unknown; name?: unknown };
    if (typeof id !== 'string' || !/^Q[1-9]\d*$/.test(id) || typeof name !== 'string') return [];
    const clean = name.trim();
    if (!clean || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name: clean }];
  });
}

export async function fetchIconicStudios(
  atlas: string | null | undefined,
  ref: { type: MediaType; id: number },
  signal?: AbortSignal,
  fetchImpl: typeof fetch = relayFetch,
): Promise<IconicStudio[]> {
  if (!atlas) return [];
  const base = atlas.replace(/\/$/, '');
  const type = ref.type === 'tv' ? 'series' : 'movie';
  try {
    const response = await fetchImpl(`${base}/index/studios/${type}/${ref.id}.json`, { signal });
    return response.ok ? parseIconicStudios(await response.json()) : [];
  } catch {
    return [];
  }
}
