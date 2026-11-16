import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const scripts = JSON.parse(readFileSync(resolve(root, 'web/package.json'), 'utf8'))
  .scripts as Record<string, string>;

describe('documented rehearsals', () => {
  it('names only package scripts that still exist', () => {
    const documented = [...readme.matchAll(/npm run (rehearse(?::[\w-]+)?)/g)].map(
      ([, command]) => command,
    );

    expect(documented).toEqual(['rehearse:household', 'rehearse:join', 'rehearse:release']);
    for (const command of documented) expect(scripts).toHaveProperty(command);
    expect(scripts).not.toHaveProperty('rehearse');
  });
});
