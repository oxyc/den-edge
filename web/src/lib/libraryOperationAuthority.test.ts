import { describe, expect, it, vi } from 'vitest';
import { DurableOperationAuthority } from './libraryOperationAuthority';
import type { LibraryServiceAuthority } from './libraryServiceCore';
import type { LibraryLog } from './log';

function storedLog() {
  const kept = new Map<string, unknown>();
  let failKeep = false;
  return {
    log: {
      libraryId: 'library-1',
      kept: async <T>(name: string) => structuredClone(kept.get(name)) as T | undefined,
      keep: async (name: string, value: unknown) => {
        if (failKeep) {
          failKeep = false;
          throw new Error('disk full');
        }
        kept.set(name, structuredClone(value));
      },
    } as unknown as LibraryLog,
    kept,
    failNextKeep: () => (failKeep = true),
  };
}

function base() {
  return {
    generation: 'generation-1',
    select: vi.fn(),
    query: vi.fn(),
    observe: vi.fn(),
    command: vi.fn(async () => ({
      outcome: 'applied' as const,
      delivery: 'queued' as const,
      affected: [{ kind: 'downloads' as const }],
    })),
    task: vi.fn(async () => ({
      result: { kind: 'history.import' as const, written: 1, total: 1, complete: true },
      affected: [{ kind: 'history' as const }],
    })),
  } satisfies LibraryServiceAuthority;
}

describe('DurableOperationAuthority', () => {
  it('does not lose operation receipts written by concurrent service instances', async () => {
    const stored = storedLog();
    let held = Promise.resolve();
    const lock = <T>(_name: string, work: () => Promise<T>) => {
      const result = held.then(work);
      held = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    const first = new DurableOperationAuthority(base(), stored.log, lock);
    const second = new DurableOperationAuthority(base(), stored.log, lock);

    await Promise.all([
      first.command({ kind: 'watchlist.add', title: { type: 'movie', id: 1 } }, 'one'),
      second.command({ kind: 'watchlist.add', title: { type: 'movie', id: 2 } }, 'two'),
    ]);

    expect([...stored.kept.values()][0]).toEqual([
      expect.objectContaining({ operationId: 'one' }),
      expect.objectContaining({ operationId: 'two' }),
    ]);
  });

  it('returns the original command result after authority replacement without executing again', async () => {
    const stored = storedLog();
    const first = base();
    const command = {
      kind: 'download.enqueue' as const,
      title: { target: { type: 'movie' as const, id: 1 }, name: 'One' },
      release: { identity: 'release-1', label: 'One' },
    };
    await new DurableOperationAuthority(first, stored.log).command(command, 'operation-1');

    const replacement = base();
    const replayed = await new DurableOperationAuthority(replacement, stored.log).command(
      command,
      'operation-1',
    );
    expect(replayed).toEqual({
      outcome: 'applied',
      delivery: 'queued',
      affected: [{ kind: 'downloads' }],
    });
    expect(replacement.command).not.toHaveBeenCalled();
  });

  it('persists an intent before effects and resumes the same operation after a receipt write failure', async () => {
    const stored = storedLog();
    const first = base();
    const command = { kind: 'watchlist.add' as const, title: { type: 'movie' as const, id: 7 } };
    const wrapped = new DurableOperationAuthority(first, stored.log);
    // The first keep is the intent. Fail the completion keep from inside the effect.
    vi.mocked(first.command).mockImplementationOnce(async () => {
      stored.failNextKeep();
      return { outcome: 'applied', delivery: 'queued', affected: [{ kind: 'overview' }] };
    });
    await expect(wrapped.command(command, 'crash-boundary')).rejects.toThrow('disk full');
    expect(first.command).toHaveBeenCalledOnce();

    const replacement = base();
    await expect(
      new DurableOperationAuthority(replacement, stored.log).command(command, 'crash-boundary'),
    ).resolves.toMatchObject({ outcome: 'applied' });
    expect(replacement.command).toHaveBeenCalledOnce();
  });

  it('stores only a fixed request digest for a maximum-shape import payload', async () => {
    const stored = storedLog();
    const items = Array.from({ length: 100_000 }, (_, id) => ({
      title: { type: 'movie' as const, id: id + 1 },
      watchedAt: id + 1,
    }));
    await new DurableOperationAuthority(base(), stored.log).task(
      { kind: 'history.import', items },
      'large-import',
    );
    const encoded = JSON.stringify([...stored.kept.values()][0]);
    expect(encoded.length).toBeLessThan(2_000);
    expect(encoded).not.toContain('watchedAt');
    expect(encoded).toContain('requestDigest');
  });

  it('refuses an authority result that would exceed the bounded encrypted journal', async () => {
    const stored = storedLog();
    const authority = base();
    vi.mocked(authority.command).mockResolvedValueOnce({
      outcome: 'applied',
      delivery: 'queued',
      affected: Array.from({ length: 10_000 }, () => ({ kind: 'downloads' as const })),
    });
    await expect(
      new DurableOperationAuthority(authority, stored.log).command(
        { kind: 'watchlist.add', title: { type: 'movie', id: 1 } },
        'oversized-result',
      ),
    ).rejects.toMatchObject({ failure: { code: 'storage', retryable: true } });
    expect(JSON.stringify([...stored.kept.values()][0]).length).toBeLessThan(1_000);
  });

  it('deduplicates tasks across replacement and rejects operation identity reuse', async () => {
    const stored = storedLog();
    const task = {
      kind: 'history.import' as const,
      items: [{ title: { type: 'movie' as const, id: 1 }, watchedAt: 10 }],
    };
    await new DurableOperationAuthority(base(), stored.log).task(task, 'task-1');

    const replacement = base();
    const authority = new DurableOperationAuthority(replacement, stored.log);
    await expect(authority.task(task, 'task-1')).resolves.toMatchObject({
      result: { kind: 'history.import', written: 1, complete: true },
    });
    expect(replacement.task).not.toHaveBeenCalled();
    await expect(authority.task({ kind: 'recovery.disable' }, 'task-1')).rejects.toMatchObject({
      failure: { code: 'conflict', retryable: false },
    });
  });

  it('does not journal an incomplete import so the same operation can resume', async () => {
    const stored = storedLog();
    const authority = base();
    vi.mocked(authority.task)
      .mockResolvedValueOnce({
        result: { kind: 'history.import', written: 250, total: 300, complete: false },
        affected: [{ kind: 'history' }],
      })
      .mockResolvedValueOnce({
        result: { kind: 'history.import', written: 50, total: 50, complete: true },
        affected: [{ kind: 'history' }],
      });
    const wrapped = new DurableOperationAuthority(authority, stored.log);
    const task = {
      kind: 'history.import' as const,
      items: [{ title: { type: 'movie' as const, id: 1 }, watchedAt: 10 }],
    };

    await expect(wrapped.task(task, 'import-1')).resolves.toMatchObject({
      result: { complete: false },
    });
    await expect(wrapped.task(task, 'import-1')).resolves.toMatchObject({
      result: { complete: true },
    });
    expect(authority.task).toHaveBeenCalledTimes(2);
  });
});
