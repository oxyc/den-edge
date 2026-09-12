import { describe, expect, it } from 'vitest';
import fixtures from '../vendor/den-core/policy-v1.json';
import { syncPolicy } from './syncCore';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import manifest from '../vendor/den-core/SOURCE.json';

describe('shared Rust WASM sync policy', () => {
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
