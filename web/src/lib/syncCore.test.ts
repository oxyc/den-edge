import { describe, expect, it } from 'vitest';
import fixtures from '../vendor/den-core/policy-v1.json';
import { inPolicySlices, syncPolicy } from './syncCore';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import manifest from '../vendor/den-core/SOURCE.json';

describe('shared Rust WASM sync policy', () => {
  it('yields after a bounded amount of staged synchronous work', async () => {
    let now = 0;
    let yields = 0;
    const seen: number[] = [];
    await inPolicySlices(
      [1, 2, 3, 4, 5],
      (value) => {
        seen.push(value);
        now += 2;
      },
      {
        budgetMs: 4,
        now: () => now,
        yieldTask: async () => {
          yields++;
        },
      },
    );
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(yields).toBe(2);
  });

  it('stops staged work when its owner is replaced during a yield', async () => {
    let now = 0;
    let live = true;
    const seen: number[] = [];
    const completed = await inPolicySlices(
      [1, 2, 3, 4],
      (value) => {
        seen.push(value);
        now += 2;
      },
      {
        budgetMs: 4,
        now: () => now,
        shouldContinue: () => live,
        yieldTask: async () => {
          live = false;
        },
      },
    );
    expect(completed).toBe(false);
    expect(seen).toEqual([1, 2]);
  });

  it('vendored artifacts match their source-pinned manifest', () => {
    expect(manifest.sourceDigest).toHaveLength(64);
    for (const [path, expected] of Object.entries(manifest.artifacts)) {
      const bytes = readFileSync(new URL(`../vendor/den-core/${path}`, import.meta.url));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
    }
  });
  for (const test of fixtures.cases) {
    it(test.name, () => {
      if ('error' in test) expect(() => syncPolicy(test.request)).toThrow(test.error);
      else expect(syncPolicy(test.request)).toEqual(test.ok);
    });
  }
});
