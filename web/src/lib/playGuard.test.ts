import { describe, expect, it, vi } from 'vitest';
import type { ContentServiceClientPort } from './contentServiceClient';
import { BLOCKED_MESSAGE, playGuard } from './playGuard';

const contentWith = (certification: string | null, rejects = false) => {
  const query = vi.fn(async () => {
    if (rejects) throw new Error('offline');
    return {
      kind: 'title.detail' as const,
      detail:
        certification === null
          ? ({ state: 'absent' } as const)
          : ({ state: 'ready', value: { certifications: { US: certification } } } as const),
    };
  });
  return {
    content: { query, onStatus: () => () => {} } as unknown as ContentServiceClientPort,
    query,
  };
};

describe('playGuard, the one place every "Play" actually starts from', () => {
  it('refuses nothing when the household has no ceiling, without asking for metadata', async () => {
    const { content, query } = contentWith('R');
    await expect(playGuard({ type: 'movie', id: 1 }, { content })).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('allows a title at or under the ceiling', async () => {
    await expect(
      playGuard(
        { type: 'movie', id: 1 },
        { content: contentWith('PG-13').content, ceiling: 'pg13' },
      ),
    ).resolves.toBeNull();
    await expect(
      playGuard({ type: 'movie', id: 1 }, { content: contentWith('R').content, ceiling: 'r' }),
    ).resolves.toBeNull();
  });

  it('refuses a title above the ceiling, with the same message Detail shows', async () => {
    await expect(
      playGuard({ type: 'movie', id: 1 }, { content: contentWith('R').content, ceiling: 'pg13' }),
    ).resolves.toBe(BLOCKED_MESSAGE);
    await expect(
      playGuard({ type: 'movie', id: 1 }, { content: contentWith('NC-17').content, ceiling: 'r' }),
    ).resolves.toBe(BLOCKED_MESSAGE);
  });

  it('fails closed when a ceiling is set and metadata is missing or unavailable', async () => {
    await expect(
      playGuard({ type: 'movie', id: 1 }, { content: contentWith(null).content, ceiling: 'pg13' }),
    ).resolves.toBe(BLOCKED_MESSAGE);
    await expect(
      playGuard(
        { type: 'movie', id: 1 },
        { content: contentWith(null, true).content, ceiling: 'pg13' },
      ),
    ).resolves.toBe(BLOCKED_MESSAGE);
  });

  it('asks the content Worker for the household region', async () => {
    const { content, query } = contentWith('PG-13');
    await playGuard({ type: 'movie', id: 7 }, { content, ceiling: 'pg13', region: 'FI' });
    expect(query).toHaveBeenCalledWith({
      kind: 'title.detail',
      title: { type: 'movie', id: 7 },
      region: 'FI',
    });
  });
});
