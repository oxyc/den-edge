import { describe, expect, it, vi } from 'vitest';
import { DownloadSourceLoader } from './downloadSourceLoader';
import type { LibraryModel } from './libraryModel.svelte';

const title = (id: number) => ({ target: { type: 'movie' as const, id }, name: `Title ${id}` });

describe('DownloadSourceLoader', () => {
  it('drops a late result from the previous title', async () => {
    const pending = new Map<number, (value: unknown) => void>();
    const model = {
      downloadSources: vi.fn(
        (requested: ReturnType<typeof title>) =>
          new Promise((resolve) => pending.set(requested.target.id, resolve)),
      ),
    } as unknown as LibraryModel;
    const loader = new DownloadSourceLoader();
    const first = loader.load(model, title(1));
    const second = loader.load(model, title(2));
    pending.get(2)?.({ result: { kind: 'download.sources', sources: [] }, version: {} });
    await expect(second).resolves.toEqual({ sources: [] });
    pending.get(1)?.({ result: { kind: 'download.sources', sources: null }, version: {} });
    await expect(first).resolves.toBeUndefined();
  });

  it('drops both success and error after cancellation', async () => {
    let reject!: (error: unknown) => void;
    const model = {
      downloadSources: () => new Promise((_resolve, failed) => (reject = failed)),
    } as unknown as LibraryModel;
    const loader = new DownloadSourceLoader();
    const loading = loader.load(model, title(1));
    loader.cancel();
    reject(new Error('late'));
    await expect(loading).resolves.toBeUndefined();
  });
});
