import type { RowDef } from './catalog';
import type { ContentServiceClientPort } from './contentServiceClient';
import type { ContentKidsHomeRow, ContentKidsHomeSource } from './contentServiceProtocol';
import type { HomeRowAffinity } from './homeRowRanking';

type Json = Record<string, unknown>;

const object = (value: unknown): Json | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;

const mediaType = (value: unknown): 'movie' | 'tv' | null =>
  value === 'movie' ? 'movie' : value === 'series' ? 'tv' : null;

function affinityRefs(value: unknown): Array<{ type: 'movie' | 'tv'; id: number }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) return [];
  const refs = value.flatMap((candidate) => {
    const ref = object(candidate);
    const type = mediaType(ref?.type);
    return type && Number.isSafeInteger(ref?.id) && Number(ref!.id) > 0
      ? [{ type, id: Number(ref!.id) }]
      : [];
  });
  return refs.length === value.length ? refs : [];
}

function sourceOf(value: unknown): ContentKidsHomeSource | null {
  const source = object(value);
  if (!source || typeof source.kind !== 'string') return null;
  if (source.kind === 'query') {
    const minimumScore = source.minimum_score;
    const affinity = affinityRefs(source.affinity);
    return typeof source.query === 'string' &&
      source.query.trim() &&
      typeof minimumScore === 'number' &&
      Number.isFinite(minimumScore) &&
      minimumScore >= 0 &&
      (source.affinity === undefined || affinity?.length)
      ? {
          kind: 'query',
          query: source.query,
          minimumScore,
          ...(affinity?.length ? { affinity } : {}),
        }
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
    const affinity = affinityRefs(source.affinity);
    return type &&
      selection.length === rawSelection.length &&
      selection.length &&
      (source.affinity === undefined || affinity?.length)
      ? { kind: 'filter', type, selection, ...(affinity?.length ? { affinity } : {}) }
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
  return answer.answer.value.rows.map(({ id, title, group, source }) => {
    const cursor = crypto.randomUUID();
    // The billboard and the visible shelf can ask for page one in the same frame. One promise keeps the cursor's
    // paging state single-threaded and gives both consumers the identical policy-bound page.
    const pages = new Map<number, Promise<import('./library').Title[]>>();
    const selections = source.kind === 'filter' ? source.selection : [];
    const values = (kind: string) =>
      selections.flatMap((selection) => {
        const at = selection.indexOf(':');
        return selection.slice(0, at) === kind ? selection.slice(at + 1).split('|') : [];
      });
    const numbers = (kind: string) => values(kind).map(Number).filter(Number.isFinite);
    const refs =
      source.kind === 'franchise' ? [{ type: source.type, id: source.id }] : source.affinity;
    const affinity: HomeRowAffinity = {
      group,
      ...(refs?.length ? { refs } : {}),
      ...(numbers('genre').length ? { genres: numbers('genre') } : {}),
      ...(numbers('decade').length ? { decades: numbers('decade') } : {}),
      ...(values('language').length ? { languages: values('language') } : {}),
      ...(values('country').length ? { countries: values('country') } : {}),
    };
    return {
      id: `kids-${id}`,
      title,
      affinity,
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
