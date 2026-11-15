import { describe, expect, it, vi } from 'vitest';
import { exclusive } from './exclusive';

describe('exclusive fallback', () => {
  it('serializes same-name work without Web Locks and releases after rejection', async () => {
    vi.stubGlobal('navigator', {});
    const order: string[] = [];
    let release!: () => void;
    const held = exclusive('profile-create', async () => {
      order.push('first-start');
      await new Promise<void>((resolve) => (release = resolve));
      order.push('first-end');
      throw new Error('first failed');
    });
    const next = exclusive('profile-create', async () => order.push('second'));
    const other = exclusive('other', async () => order.push('other'));

    await vi.waitFor(() => expect(order).toEqual(['first-start', 'other']));
    release();
    await expect(held).rejects.toThrow('first failed');
    await expect(next).resolves.toBe(4);
    await expect(other).resolves.toBe(2);
    expect(order).toEqual(['first-start', 'other', 'first-end', 'second']);
  });
});
