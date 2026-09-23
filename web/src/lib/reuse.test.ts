import { beforeEach, describe, expect, it } from 'vitest';
import { forgetReused, reuse, REUSE_MS } from './reuse';

beforeEach(forgetReused);

describe('reuse', () => {
  it('hands every caller within the window the one answer, and asks again after it', async () => {
    let asked = 0;
    const make = async () => ++asked;
    expect(await reuse('q', make, 0)).toBe(1);
    expect(await reuse('q', make, REUSE_MS - 1), 'a second ask joins the first').toBe(1);
    expect(asked).toBe(1);
    expect(await reuse('other', make, 0), 'another question is its own').toBe(2);
    expect(await reuse('q', make, REUSE_MS), 'past the window the question is asked again').toBe(3);
  });

  it('joins an answer still on its way', async () => {
    let release!: (value: string) => void;
    let asked = 0;
    const make = () => {
      asked++;
      return new Promise<string>((resolve) => (release = resolve));
    };
    const first = reuse('slow', make, 0);
    const second = reuse('slow', make, 1);
    release('done');
    expect(await Promise.all([first, second])).toEqual(['done', 'done']);
    expect(asked).toBe(1);
  });

  it('does not keep a failure: the next caller asks again', async () => {
    let asked = 0;
    const failing = async () => {
      asked++;
      throw new Error('offline');
    };
    await expect(reuse('q', failing, 0)).rejects.toThrow('offline');
    await expect(reuse('q', failing, 1)).rejects.toThrow('offline');
    expect(asked).toBe(2);
  });
});
