import { beforeEach, expect, it, vi } from 'vitest';
import { projectDocument, projectEpisode } from './libraryV4';
import { syncPolicy } from './syncCore';
import type { DocumentRow } from './wire';

vi.mock('./syncCore', () => ({ syncPolicy: vi.fn() }));

const policy = vi.mocked(syncPolicy);
const at = (time: number) => [time, 0, 'aaaaaaaaaaaaaaaa'] as const;

const season = (): DocumentRow => ({
  format: 4,
  kind: 'season',
  title: { type: 'tv', id: 1399 },
  season: 2,
  seasonReset: null,
  episodes: {
    1: { progress: null, imported: true, plays: {}, cleared: null },
    2: {
      progress: { value: 0.5, at: at(2_000), viewing: 3, seconds: 900 },
      imported: false,
      plays: {},
      cleared: null,
    },
  },
});

beforeEach(() => policy.mockReset());

it('projects one season with one bounded policy call and keeps the legacy episode rows', () => {
  policy.mockReturnValueOnce({
    '1': { watched: true, resume: null, viewing: 0, watched_at: 1_000 },
    '2': {
      watched: false,
      resume: { value: 0.5, at: at(2_000), viewing: 3, seconds: 900 },
      viewing: 3,
      watched_at: null,
    },
  });
  const document = season();

  expect(projectDocument(document)).toEqual([
    {
      kind: 'ep',
      schema: 2,
      title: { type: 'tv', id: 1399 },
      season: 2,
      episode: 1,
      progress: { value: 1, viewing: 0, at: [1_000, 0, ''] },
    },
    {
      kind: 'ep',
      schema: 2,
      title: { type: 'tv', id: 1399 },
      season: 2,
      episode: 2,
      progress: { value: 0.5, at: at(2_000), viewing: 3, seconds: 900 },
    },
  ]);
  expect(policy).toHaveBeenCalledOnce();
  expect(policy).toHaveBeenCalledWith({
    op: 'season_state_v4',
    season: document,
    now: expect.any(Number),
  });

  projectDocument(document);
  expect(policy).toHaveBeenCalledOnce();
});

it('keeps a direct episode read on the single-episode parity operation', () => {
  policy.mockReturnValueOnce({ watched: false, resume: null, viewing: 4, watched_at: null });
  const document = season();

  expect(projectEpisode(undefined, document, document.title, 2, 1)?.progress).toEqual({
    value: 0,
    viewing: 4,
    at: [0, 0, ''],
  });
  expect(policy).toHaveBeenCalledWith({
    op: 'episode_state_v4',
    season: document,
    episode: 1,
    now: expect.any(Number),
  });
});
