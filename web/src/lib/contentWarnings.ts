// doesthedogdie's content warnings for a title, as den-edge keeps them (`/warnings/imdb/<id>`).
//
// Asked of this origin, never of doesthedogdie: the key rides an `x-api-key` header, so a browser preflights, and
// they answer none. den-edge looks a title up once and keeps it for every browser, so a key here only decides
// whether a title nobody has opened yet may be looked up: this page's own key when it has one, the household's for
// a member of the library (`relayFetch` proves membership). A visitor sees what is already kept.

export interface Warning {
  id: number;
  label: string;
  votes: number;
}

/**
 * The warnings to show: confirmed by more yes votes than no, never a spoiler, and among `categories` if any are picked.
 * Each once: an answer can list a topic more than once, with different votes (The Wire's names "a dog dies" five
 * times), and the one kept is the one with the most yes votes.
 */
export function parseWarnings(body: unknown, categories: string[]): Warning[] {
  const rows = (body as { warnings?: unknown } | null)?.warnings;
  if (!Array.isArray(rows)) return [];
  const seen = new Set<number>();
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
    .sort((a, b) => b.votes - a.votes)
    .filter((warning) => !seen.has(warning.id) && !!seen.add(warning.id));
}
