import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const guide = readFileSync(resolve(root, 'docs/tv-install.md'), 'utf8');
const version = (path: string) => readFileSync(resolve(root, path), 'utf8').trim();

// Each package's release tag is derived from its VERSION file by its publish workflow.
const packages = [
  ['tv-android-v', 'android-tv/VERSION'],
  ['tv-webos-v', 'web/tv-packaging/webos/VERSION'],
  ['tv-samsung-v', 'web/tv-packaging/tizen/VERSION'],
] as const;

describe('TV install guide', () => {
  for (const [prefix, file] of packages) {
    it(`links only the ${prefix}<version> release named by ${file}`, () => {
      const tags = new Set(guide.match(new RegExp(`${prefix}[0-9][0-9.]*`, 'g')));

      expect([...tags]).toEqual([`${prefix}${version(file)}`]);
    });
  }
});
