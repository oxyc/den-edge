import type { Row } from './wire';

export type BoundaryCounts = [activity: number, settings: number, delivery: number, unknown: number];

export const boundaryCounts = (): BoundaryCounts => [0, 0, 0, 0];

/** Count a refused/dropped row without deriving or retaining its identity. */
export function addBoundaryRow(counts: BoundaryCounts, row: Pick<Row, 'kind'>): void {
  switch (row.kind) {
    case 'rec':
    case 'ep':
    case 'title':
    case 'season':
      counts[0]++;
      break;
    case 'set':
      counts[1]++;
      break;
    case 'delivery':
      counts[2]++;
      break;
    default:
      counts[3]++;
  }
}

/** Fixed vocabulary and fixed category count: no row/profile identity can enter this diagnostic. */
export function boundarySummary(counts: BoundaryCounts): string {
  return `activity=${counts[0]}, settings=${counts[1]}, delivery=${counts[2]}, unknown=${counts[3]}`;
}
