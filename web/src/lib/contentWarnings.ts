// doesthedogdie's content warnings for a title, as den-edge keeps them (`/warnings/imdb/<id>`).
//
// Asked of this origin, never of doesthedogdie: the key rides an `x-api-key` header, so a browser preflights, and
// they answer none. den-edge looks a title up once and keeps it for every browser, so a key here only decides
// whether a title nobody has opened yet may be looked up: this page's own key when it has one, the household's for
// a member of the library (`relayFetch` proves membership). A visitor sees what is already kept.
import type { TitleDetail } from './detail';
import { relayFetch } from './relayFetch';

export interface Warning {
  id: number;
  label: string;
  votes: number;
}

/** The warnings to show: confirmed by more yes votes than no, never a spoiler, and among `categories` if any are picked. */
export function parseWarnings(body: unknown, categories: string[]): Warning[] {
  const rows = (body as { warnings?: unknown } | null)?.warnings;
  if (!Array.isArray(rows)) return [];
  return rows
    .flatMap((r): Warning[] => {
      const id = Number(r?.id),
        yes = Number(r?.yes ?? 0),
        no = Number(r?.no ?? 0);
      if (
        !Number.isInteger(id) ||
        r?.spoiler ||
        (categories.length && !categories.includes(r?.category)) ||
        !Number.isFinite(yes) ||
        !Number.isFinite(no) ||
        yes <= no ||
        yes < 1
      )
        return [];
      const label = r?.name;
      return typeof label === 'string' && label.trim() ? [{ id, label, votes: yes }] : [];
    })
    .sort((a, b) => b.votes - a.votes);
}

export async function fetchWarnings(
  detail: TitleDetail,
  key: string,
  categories: string[],
  signal?: AbortSignal,
  fetchImpl: typeof fetch = relayFetch,
): Promise<{ id: number; warnings: Warning[] } | null> {
  if (!detail.imdbId) return null;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (key) headers['x-api-key'] = key;
  try {
    const res = await fetchImpl(`/warnings/imdb/${encodeURIComponent(detail.imdbId)}`, {
      signal,
      headers,
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const id = Number((body as { id?: unknown } | null)?.id);
    if (!Number.isInteger(id) || id < 1) return null;
    return { id, warnings: parseWarnings(body, categories) };
  } catch {
    return null;
  }
}
