import type { RowDef } from './catalog';
import type { ContentServiceClientPort } from './contentServiceClient';
import type { ContentKidsHomeRow, ContentKidsHomeSource } from './contentServiceProtocol';

type Json = Record<string, unknown>;

const object = (value: unknown): Json | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;

const mediaType = (value: unknown): 'movie' | 'tv' | null =>
  value === 'movie' ? 'movie' : value === 'series' ? 'tv' : null;

function sourceOf(value: unknown): ContentKidsHomeSource | null {
  const source = object(value);
  if (!source || typeof source.kind !== 'string') return null;
  if (source.kind === 'query') {
    const minimumScore = source.minimum_score;
    return typeof source.query === 'string' &&
      source.query.trim() &&
      typeof minimumScore === 'number' &&
      Number.isFinite(minimumScore) &&
      minimumScore >= 0
      ? { kind: 'query', query: source.query, minimumScore }
      : null;
  }
  if (source.kind === 'franchise') {
    const type = mediaType(source.type);
    return type && Number.isSafeInteger(source.id) && Number(source.id) > 0
      ? { kind: 'franchise', type, id: Number(source.id) }
      : null;
  }
  if (source.kind === 'filter') {
    const type = source.type === 'all' ? 'all' : mediaType(source.type);
    const rawSelection = Array.isArray(source.selection) ? source.selection : [];
    const selection = rawSelection.filter(
      (item): item is string => typeof item === 'string' && item.includes(':'),
    );
    return type && selection.length === rawSelection.length && selection.length
      ? { kind: 'filter', type, selection }
      : null;
  }
  return null;
}

/** The checked-in Atlas catalogue, with provider spelling normalized to Den Web's media types. */
export function parseKidsHomeCatalogue(value: unknown): ContentKidsHomeRow[] {
  const body = object(value);
  if (!body || !Array.isArray(body.rows)) return [];
  const seen = new Set<string>();
  return body.rows.flatMap((candidate): ContentKidsHomeRow[] => {
    const row = object(candidate);
    if (
      !row ||
      typeof row.id !== 'string' ||
      !row.id ||
      seen.has(row.id) ||
      typeof row.title !== 'string' ||
      !row.title.trim() ||
      typeof row.group !== 'string' ||
      !row.group
    )
      return [];
    const source = sourceOf(row.source);
    if (!source) return [];
    seen.add(row.id);
    return [{ id: row.id, title: row.title, group: row.group, source }];
  });
}

/** Kid Home's rows, each paged through the active profile's policy-bound content authority. */
export async function kidsHomeRows(content: ContentServiceClientPort): Promise<RowDef[]> {
  const answer = await content.query({ kind: 'atlas.query', query: { operation: 'kids-home' } });
  if (answer.answer.state !== 'ready' || answer.answer.value.operation !== 'kids-home') return [];
  return answer.answer.value.rows.map(({ id, title, source }) => {
    const cursor = crypto.randomUUID();
    // The billboard and the visible shelf can ask for page one in the same frame. One promise keeps the cursor's
    // paging state single-threaded and gives both consumers the identical policy-bound page.
    const pages = new Map<number, Promise<import('./library').Title[]>>();
    return {
      id: `kids-${id}`,
      title,
      load: (page) => {
        let loading = pages.get(page);
        if (!loading) {
          loading = content
            .query({
              kind: 'atlas.query',
              query: { operation: 'kids-row', cursor, source, page },
            })
            .then((result) =>
              result.answer.state === 'ready' && result.answer.value.operation === 'kids-row'
                ? result.answer.value.titles
                : [],
            );
          pages.set(page, loading);
        }
        return loading;
      },
    };
  });
}
