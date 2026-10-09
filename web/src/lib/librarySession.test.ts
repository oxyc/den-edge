import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryModel } from './libraryModel.svelte';
import { LibrarySession } from './librarySession.svelte';

afterEach(() => vi.useRealTimers());

describe('LibrarySession presentation state', () => {
  it('indexes title metadata and replaces shapes without owning library rows', () => {
    const session = new LibrarySession(null);
    const title = { type: 'tv' as const, id: 1, title: 'One' };
    session.publishLibraryMetadata(
      [title, title],
      [['tv:1', { counts: new Map([[1, 8]]), lastAired: { season: 1, episode: 4 } }]],
    );

    expect(session.displays).toEqual([title]);
    expect(session.displayTitle(title)).toBe(title);
    expect(session.shapes.get('tv:1')?.counts.get(1)).toBe(8);
  });

  it('forwards each foreground and close transition once', () => {
    const foregroundReady = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    const closeWorkerServices = vi.fn();
    const content = {
      query: vi.fn(),
      onStatus: vi.fn(() => () => {}),
    };
    const model = { foregroundReady, close } as unknown as LibraryModel;
    const session = new LibrarySession(model, false, content, closeWorkerServices);

    session.foregroundReady();
    session.foregroundReady();
    session.close();
    session.close();

    expect(foregroundReady).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(session.content).toBe(content);
    expect(closeWorkerServices).toHaveBeenCalledOnce();
  });

  it('owns only transient toast and undo timing', () => {
    vi.useFakeTimers();
    const session = new LibrarySession(null);
    const run = vi.fn();
    session.notify('Removed', { holdMs: 10, undo: { label: 'Undo', run } });
    expect(session.toast).toBe('Removed');
    expect(session.undo?.run).toBe(run);
    vi.advanceTimersByTime(10);
    expect(session.toast).toBeNull();
    expect(session.undo).toBeNull();
  });
});
