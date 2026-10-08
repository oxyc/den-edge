import { describe, expect, it } from 'vitest';
import { loadHls } from './hlsLoader';

describe('loadHls', () => {
  it('hands intent warming and the detail surface the same module load', async () => {
    const intent = loadHls();
    const detail = loadHls();

    expect(detail).toBe(intent);
    await expect(detail).resolves.toHaveProperty('default');
  });
});
