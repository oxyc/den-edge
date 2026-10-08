import { describe, expect, it } from 'vitest';
import { blankTitle } from './actions';
import { openClockStore } from './clockStore';
import { LibraryLogAuthority } from './libraryLogAuthority';
import { LibraryServiceAuthorityError } from './libraryServiceCore';
import type { Vault } from './localVault';
import { LibraryLog } from './log';
import { ensureSyncPolicy } from './syncLoader';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(19)));
const movie = { type: 'movie' as const, id: 7 };
const series = { type: 'tv' as const, id: 11 };

function memoryVault(): Vault {
  const data = new Map<string, Uint8Array>();
  return {
    get: async (key) => data.get(key)?.slice(),
    entries: async (prefix) =>
      [...data]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key, value.slice()]),
    put: async (key, value) => void data.set(key, value.slice()),
    delete: async (key) => void data.delete(key),
    remove: async (prefix) => {
      for (const key of data.keys()) if (key.startsWith(prefix)) data.delete(key);
    },
  };
}

async function localAuthority() {
  const vault = memoryVault();
  const log = (await LibraryLog.openLocal(KEY, vault))!;
  const clock = await openClockStore(vault, {
    key: 'authority-test-clock',
    createDevice: () => '0123456789abcdef',
  });
  return { log, authority: new LibraryLogAuthority(log, clock, { mode: 'local' }) };
}

describe('LibraryLogAuthority', () => {
  it('owns title actions and returns only semantic title views', async () => {
    const { log, authority } = await localAuthority();

    await expect(authority.select({ kind: 'title', title: movie })).resolves.toEqual({
      kind: 'title',
      title: movie,
      listed: false,
      watched: false,
      reaction: null,
      standing: null,
      progress: null,
      episodes: [],
    });

    const added = await authority.command({ kind: 'watchlist.add', title: movie }, 'add-movie');
    expect(added).toEqual({
      outcome: 'applied',
      delivery: 'local',
      affected: [
        { kind: 'title', title: movie },
        { kind: 'presence', title: movie },
        { kind: 'overview' },
        { kind: 'history' },
        { kind: 'continue' },
      ],
    });
    expect(log.settings('tracker-event:add-movie')).toBeDefined();
    await expect(
      authority.command({ kind: 'watchlist.add', title: movie }, 'add-again'),
    ).resolves.toMatchObject({ outcome: 'unchanged', affected: [] });

    await expect(
      authority.command({ kind: 'reaction.set', title: movie, reaction: 'love' }, 'love-movie'),
    ).resolves.toMatchObject({
      affected: [
        { kind: 'title', title: movie },
        { kind: 'presence', title: movie },
        { kind: 'overview' },
      ],
    });
    const progress = await authority.command(
      {
        kind: 'progress.record',
        title: movie,
        fraction: 0.4,
        seconds: 240,
        observedAt: 5_000,
      },
      'progress-is-not-a-tracker-event',
    );
    expect(progress.delivery).toBe('local');
    await expect(
      authority.command(
        { kind: 'continue-dismissed.set', title: movie, dismissed: true },
        'dismissal-is-not-a-tracker-event',
      ),
    ).resolves.toMatchObject({
      outcome: 'applied',
      affected: [{ kind: 'continue' }],
    });
    await expect(authority.query({ kind: 'playback.prepare', title: movie })).resolves.toEqual({
      kind: 'playback.prepare',
      action: 'resume',
      target: movie,
      resume: { fraction: 0.4, seconds: 240 },
    });
    await expect(authority.select({ kind: 'title', title: movie })).resolves.toMatchObject({
      listed: true,
      reaction: 'love',
      standing: 'in-progress',
      progress: { fraction: 0.4, seconds: 240 },
    });
  });

  it('uses observed series shape for episode commands, whole-series writes and playback', async () => {
    const { log, authority } = await localAuthority();

    await expect(
      authority.command({ kind: 'watched.set', title: series, watched: true }, 'series-seen'),
    ).rejects.toMatchObject({
      failure: { code: 'not-ready', retryable: true },
    });
    await expect(
      authority.observe({
        kind: 'title-shape',
        title: series,
        seasons: [
          { season: 0, episodes: 2 },
          { season: 1, episodes: 3 },
        ],
        lastAired: { season: 1, episode: 2 },
      }),
    ).resolves.toEqual({
      outcome: 'applied',
      affected: [{ kind: 'title', title: series }, { kind: 'continue' }],
    });

    await authority.command(
      {
        kind: 'progress.record',
        title: series,
        episode: { ...series, season: 1, episode: 1 },
        fraction: 0.3,
        seconds: 300,
        observedAt: 6_000,
      },
      'series-progress',
    );
    await expect(authority.query({ kind: 'playback.prepare', title: series })).resolves.toEqual({
      kind: 'playback.prepare',
      action: 'resume',
      target: { ...series, season: 1, episode: 1 },
      resume: { fraction: 0.3, seconds: 300 },
    });

    await authority.command(
      {
        kind: 'episode-watched.set',
        episode: { ...series, season: 1, episode: 1 },
        watched: true,
      },
      'episode-one-seen',
    );
    expect(log.settings('tracker-event:episode-one-seen')).toBeDefined();
    await expect(authority.query({ kind: 'playback.prepare', title: series })).resolves.toEqual({
      kind: 'playback.prepare',
      action: 'next',
      target: { ...series, season: 1, episode: 2 },
      resume: null,
    });

    await authority.command(
      {
        kind: 'season-watched.set',
        title: series,
        season: 1,
        episodes: [1, 2],
        watched: true,
      },
      'season-seen',
    );
    expect(log.settings('tracker-event:season-seen:episode:1:1')).toBeUndefined();
    expect(log.settings('tracker-event:season-seen:episode:1:2')).toBeDefined();
    await expect(authority.select({ kind: 'title', title: series })).resolves.toMatchObject({
      listed: true,
      watched: true,
      standing: 'in-progress',
      episodes: [
        { season: 1, episode: 1, watched: true },
        { season: 1, episode: 2, watched: true },
      ],
    });
    await expect(authority.query({ kind: 'playback.prepare', title: series })).resolves.toEqual({
      kind: 'playback.prepare',
      action: 'start',
      target: { ...series, season: 1, episode: 1 },
      resume: null,
    });

    await authority.command(
      { kind: 'watched.set', title: series, watched: false },
      'series-unseen',
    );
    expect(log.settings('tracker-event:series-unseen')).toBeDefined();
    await expect(authority.select({ kind: 'title', title: series })).resolves.toMatchObject({
      watched: false,
      episodes: [
        { season: 1, episode: 1, watched: false, fraction: 0 },
        { season: 1, episode: 2, watched: false, fraction: 0 },
      ],
    });
  });

  it('preserves queued and refused outcomes from an online log', async () => {
    await ensureSyncPolicy();
    const clock = {
      device: '0123456789abcdef',
      issue: async () => [2_000, 0, '0123456789abcdef'] as [number, number, string],
      see: async () => undefined,
      current: async () => [2_000, 0, '0123456789abcdef'] as [number, number, string],
    };
    let pending = 0;
    const queuedLog = {
      currentGeneration: 'generation-1',
      moved: false,
      readOnly: false,
      refusal: null,
      get pendingActions() {
        return pending;
      },
      title: () => undefined,
      newestStamp: () => [0, 0, ''] as [number, number, string],
      writeAction: async () => {
        pending++;
        return blankTitle(movie, 1);
      },
    } as unknown as LibraryLog;
    const queued = new LibraryLogAuthority(queuedLog, clock, { mode: 'online' });
    await expect(
      queued.command({ kind: 'watchlist.add', title: movie }, 'queued'),
    ).resolves.toMatchObject({ outcome: 'applied', delivery: 'queued' });

    const refusedLog = {
      ...queuedLog,
      refusal: 'library_full',
      get pendingActions() {
        return 0;
      },
      writeAction: async () => null,
    } as unknown as LibraryLog;
    const refused = new LibraryLogAuthority(refusedLog, clock, { mode: 'online' });
    await expect(
      refused.command({ kind: 'watchlist.add', title: movie }, 'refused'),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LibraryServiceAuthorityError>>({
        failure: {
          code: 'refused',
          message: 'library write was refused: library_full',
          retryable: false,
        },
      }),
    );
  });

  it('projects normalized overview, presence, Continue, and history views', async () => {
    const { authority } = await localAuthority();

    await authority.command({ kind: 'watchlist.add', title: movie }, 'overview-movie');
    await authority.command(
      { kind: 'reaction.set', title: movie, reaction: 'love' },
      'overview-love',
    );
    await authority.command(
      {
        kind: 'episode-watched.set',
        episode: { ...series, season: 1, episode: 1 },
        watched: true,
      },
      'history-episode',
    );

    await expect(authority.select({ kind: 'overview' })).resolves.toMatchObject({
      kind: 'overview',
      owned: [movie],
      watchlist: [movie],
      standings: expect.arrayContaining([
        { title: movie, standing: 'watchlist' },
        { title: series, standing: 'in-progress' },
      ]),
      weighted: [{ title: movie, weight: 1.6, updatedAt: expect.any(Number) }],
      seeds: { watched: [movie], watchlisted: [movie] },
    });
    await expect(authority.select({ kind: 'presence', titles: [series, movie] })).resolves.toEqual({
      kind: 'presence',
      items: [
        { title: series, standing: 'in-progress', reaction: null },
        { title: movie, standing: 'watchlist', reaction: 'love' },
      ],
    });
    await expect(authority.select({ kind: 'continue' })).resolves.toEqual({
      kind: 'continue',
      items: [],
      needsShapes: [series],
    });
    await expect(authority.select({ kind: 'history' })).resolves.toMatchObject({
      kind: 'history',
      items: [
        {
          title: series,
          watchedAt: expect.any(Number),
          episode: { season: 1, episode: 1 },
          episodes: 1,
        },
      ],
    });

    await authority.observe({
      kind: 'title-shape',
      title: series,
      seasons: [{ season: 1, episodes: 2 }],
      lastAired: { season: 1, episode: 2 },
    });
    await expect(authority.select({ kind: 'continue' })).resolves.toEqual({
      kind: 'continue',
      items: [
        {
          title: series,
          fraction: 0,
          episode: { season: 1, episode: 2 },
        },
      ],
      needsShapes: [],
    });
  });

  it('reports protocol surfaces it does not implement', async () => {
    const { authority } = await localAuthority();
    await expect(authority.select({ kind: 'settings' })).rejects.toMatchObject({
      failure: { code: 'invalid-request', retryable: false },
    });
  });
});
