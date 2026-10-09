import type { ContentServiceClientPort } from './contentServiceClient';
import type {
  FilterCounts,
  FilterItem,
  FilterPerson,
  FilterValue,
  PeopleCounts,
} from './filterRoutes';
import { FilterUnavailable } from './filterRoutes';
import type { ExploreType, Title } from './library';

const answer = async <Operation extends string>(
  content: ContentServiceClientPort,
  query: Parameters<ContentServiceClientPort['query']>[0] & { kind: 'atlas.query' },
  operation: Operation,
  signal?: AbortSignal,
) => {
  const result = await content.query(query, signal);
  if (result.answer.state === 'absent' || result.answer.state === 'not-configured')
    throw new FilterUnavailable('atlas has no filter answer', false);
  if (result.answer.state !== 'ready') throw new Error('atlas filter is unavailable');
  if (result.answer.value.operation !== operation)
    throw new Error('content service returned the wrong atlas answer');
  return result.answer.value;
};

export const contentFilterTitles = (
  content: ContentServiceClientPort,
  type: ExploreType,
  items: FilterItem[],
): ((page: number, signal?: AbortSignal) => Promise<Title[]>) => {
  const cursor = crypto.randomUUID();
  const selection = items.map((item) => ({ ...item }));
  return async function load(page, signal) {
    const value = await answer(
      content,
      {
        kind: 'atlas.query',
        query: { operation: 'titles', cursor, type, items: selection, page },
      },
      'titles',
      signal,
    );
    return value.operation === 'titles' ? value.titles : [];
  };
};

export async function contentFilterCounts(
  content: ContentServiceClientPort,
  type: ExploreType,
  items: FilterItem[],
  signal?: AbortSignal,
): Promise<FilterCounts | null> {
  try {
    const value = await answer(
      content,
      { kind: 'atlas.query', query: { operation: 'counts', type, items } },
      'counts',
      signal,
    );
    return value.operation === 'counts' ? value.counts : null;
  } catch {
    return null;
  }
}

export async function contentFilterValues(
  content: ContentServiceClientPort,
  type: ExploreType,
  valueKind: string,
  query: string,
  items: FilterItem[],
  signal?: AbortSignal,
): Promise<FilterValue[] | null> {
  try {
    const value = await answer(
      content,
      {
        kind: 'atlas.query',
        query: { operation: 'values', type, items, valueKind, query },
      },
      'values',
      signal,
    );
    return value.operation === 'values' ? value.values : null;
  } catch {
    return null;
  }
}

export const contentFilterPeople = (
  content: ContentServiceClientPort,
  type: ExploreType,
  items: FilterItem[],
  traits: FilterItem[],
  order?: string,
): ((page: number) => Promise<{ people: FilterPerson[]; total: number }>) =>
  async function load(page) {
    const value = await answer(
      content,
      {
        kind: 'atlas.query',
        query: { operation: 'people', type, items, traits, order, page },
      },
      'people',
    );
    if (value.operation !== 'people') return { people: [], total: 0 };
    return { people: value.people, total: value.total };
  };

export async function contentPeopleCounts(
  content: ContentServiceClientPort,
  type: ExploreType,
  items: FilterItem[],
  traits: FilterItem[],
  signal?: AbortSignal,
): Promise<PeopleCounts | null> {
  try {
    const value = await answer(
      content,
      { kind: 'atlas.query', query: { operation: 'people-counts', type, items, traits } },
      'people-counts',
      signal,
    );
    return value.operation === 'people-counts' ? value.counts : null;
  } catch {
    return null;
  }
}

export async function contentTraitValues(
  content: ContentServiceClientPort,
  type: ExploreType,
  trait: string,
  query: string,
  items: FilterItem[],
  traits: FilterItem[],
  signal?: AbortSignal,
): Promise<FilterValue[] | null> {
  try {
    const value = await answer(
      content,
      {
        kind: 'atlas.query',
        query: { operation: 'trait-values', type, items, traits, trait, query },
      },
      'trait-values',
      signal,
    );
    return value.operation === 'trait-values' ? value.values : null;
  } catch {
    return null;
  }
}
