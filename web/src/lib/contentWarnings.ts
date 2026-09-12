import type { TitleDetail } from './detail';
export interface Warning { id: number; label: string; votes: number }
export function parseWarnings(body: unknown, categories: string[]): Warning[] {
  const rows = (body as { topicItemStats?: unknown } | null)?.topicItemStats;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r): Warning[] => {
    const t = r?.topic, yes = Number(r?.yesSum ?? 0), no = Number(r?.noSum ?? 0);
    if (!t || !Number.isFinite(t.id) || t.isSpoiler || !categories.includes(t.TopicCategory?.name) || !Number.isFinite(yes) || !Number.isFinite(no) || yes <= no || yes < 1) return [];
    const label = t.smmwDescription || t.doesName || t.name;
    return typeof label === 'string' && label.trim() ? [{ id: t.id, label, votes: yes }] : [];
  }).sort((a, b) => b.votes - a.votes);
}

export async function fetchWarnings(detail: TitleDetail, key: string, categories: string[], signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch): Promise<{ id: number; warnings: Warning[] } | null> {
  if (!key || !categories.length) return null;
  const get = async (path: string) => {
    const res = await fetchImpl('https://www.doesthedogdie.com' + path, { signal, headers: { accept: 'application/json', 'x-api-key': key } });
    return res.ok ? await res.json() : null;
  };
  try {
    const search = await get(`/search?q=${encodeURIComponent(detail.title.title)}`);
    const items = Array.isArray(search?.items) ? search.items : [];
    const match = items.find((i: { imdbId?: string }) => detail.imdbId && i.imdbId === detail.imdbId)
      ?? items.find((i: { name?: string; releaseYear?: string }) => i.name?.toLocaleLowerCase() === detail.title.title.toLocaleLowerCase()
        && (!detail.title.year || Number(i.releaseYear) === detail.title.year));
    if (!match || !Number.isInteger(match.id) || match.id < 1) return null;
    return { id: match.id, warnings: parseWarnings(await get(`/media/${match.id}`), categories) };
  } catch { return null; }
}
