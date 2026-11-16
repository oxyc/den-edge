import type { Row } from './wire';

export type BoundaryClass = 'activity' | 'settings' | 'delivery' | 'unknown';
export type BoundaryCounts = Record<BoundaryClass, number>;

export const boundaryCounts = (): BoundaryCounts => ({
  activity: 0,
  settings: 0,
  delivery: 0,
  unknown: 0,
});

export function addBoundaryCount(counts: BoundaryCounts, kind: BoundaryClass, amount = 1): void {
  counts[kind] += amount;
}

/** Count a refused/dropped row without deriving or retaining its identity. */
export function addBoundaryRow(counts: BoundaryCounts, row: Pick<Row, 'kind'>): void {
  switch (row.kind) {
    case 'rec':
    case 'ep':
    case 'title':
    case 'season':
      counts.activity++;
      break;
    case 'set':
      counts.settings++;
      break;
    case 'delivery':
      counts.delivery++;
      break;
    default:
      counts.unknown++;
  }
}

/** Fixed vocabulary and fixed category count: no row/profile identity can enter this diagnostic. */
export function boundarySummary(counts: BoundaryCounts): string {
  return (Object.entries(counts) as [BoundaryClass, number][])
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind}=${count}`)
    .join(', ');
}
