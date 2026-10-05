import { beforeEach, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ requests: [] as Record<string, unknown>[] }));

vi.mock('./syncCore', () => ({
  syncPolicy: (request: Record<string, unknown>) => {
    mocked.requests.push(request);
    const document = request.document as {
      kind: string;
      title: { type: string; id: number };
      season?: number;
    };
    return document.kind === 'season'
      ? `season:${document.title.type}:${document.title.id}:${document.season ?? 0}`
      : `${document.kind}:${document.title.type}:${document.title.id}`;
  },
}));

beforeEach(() => (mocked.requests.length = 0));

it('names an unchanged document through policy once and invalidates by immutable row identity', async () => {
  const { rowName } = await import('./wire');
  const document = {
    kind: 'title' as const,
    format: 4,
    title: { type: 'movie' as const, id: 603 },
  };

  expect(rowName(document)).toBe('title:movie:603');
  expect(rowName(document)).toBe('title:movie:603');
  expect(mocked.requests).toHaveLength(1);

  expect(rowName({ ...document })).toBe('title:movie:603');
  expect(mocked.requests).toHaveLength(2);
});
