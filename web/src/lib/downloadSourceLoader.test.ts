import { describe, expect, it } from 'vitest';
import { loadDownloadSources } from './downloadSourceLoader';
import type { LibraryModel } from './libraryModel.svelte';

const title = (id: number) => ({ target: { type: 'movie' as const, id }, name: `Title ${id}` });

describe('loadDownloadSources', () => {
  it('normalizes a synchronous command throw to an unreachable result', async () => {
    const model = {
      downloadSources: () => {
        throw new Error('command unavailable');
      },
    } as unknown as LibraryModel;

    await expect(loadDownloadSources(model, title(1))).resolves.toBeNull();
  });
});
