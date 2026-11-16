import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const guide = readFileSync(resolve(import.meta.dirname, '../../docs/smart-tv.md'), 'utf8');

describe('Samsung source-build guide', () => {
  it('pins the public device and service origins on both build commands', () => {
    const samsung = guide.slice(
      guide.indexOf('## Samsung Tizen'),
      guide.indexOf('\n## ', guide.indexOf('## Samsung Tizen') + 1),
    );
    const commands = samsung.match(/^DEN_TV_[^\n]+$/gm) ?? [];

    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command).toContain('DEN_TV_API_ORIGIN=https://d-api.oxy.fi');
      expect(command).toContain('DEN_TV_SERVICE_ORIGIN=https://d.oxy.fi');
    }
    expect(commands[0]).toContain('npm run build:tv:tizen');
    expect(commands[1]).toContain('node scripts/tv-package.mjs tizen --url https://d-api.oxy.fi');
  });
});
