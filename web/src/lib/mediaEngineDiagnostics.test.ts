import { describe, expect, it, vi } from 'vitest';
import { reportMediaEngineFailure } from './mediaEngineDiagnostics';

describe('media engine diagnostics', () => {
  it('bounds a rejected dynamic import without forwarding its URL or stack', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sentinel = new TypeError('https://provider.invalid/reel/private-capability.m3u8');
    sentinel.stack = 'private response body and title tmdb:7349281';

    reportMediaEngineFailure('hls.js', 'startup', sentinel);

    expect(warn.mock.calls).toEqual([
      ['den: media engine failure', 'hls.js', 'startup', 'type_error'],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(
      /provider|capability|m3u8|response body|7349281/,
    );
    warn.mockRestore();
  });

  it('bounds a synchronous engine setup exception', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sentinel = new Error('chunk URL https://d.oxy.fi/assets/hls-private.js');
    sentinel.stack = 'release tt7349281 and private response body';

    reportMediaEngineFailure('hls.js', 'startup', sentinel);

    expect(warn.mock.calls).toEqual([
      ['den: media engine failure', 'hls.js', 'startup', 'exception'],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(
      /chunk URL|hls-private|d\.oxy\.fi|tt7349281|response body/,
    );
    warn.mockRestore();
  });

  it('keeps every player and trailer engine identity closed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    reportMediaEngineFailure('avplay', 'startup', new Error('private Samsung player payload'));
    reportMediaEngineFailure('trailer', 'fatal');
    reportMediaEngineFailure('trailer', 'fragment_loop');

    expect(warn.mock.calls).toEqual([
      ['den: media engine failure', 'avplay', 'startup', 'exception'],
      ['den: media engine failure', 'trailer', 'fatal', 'none'],
      ['den: media engine failure', 'trailer', 'fragment_loop', 'none'],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(
      /private Samsung|main-private|7349281|capability-secret/,
    );
    warn.mockRestore();
  });

  it('reports trailer candidate exhaustion without candidate identity', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    reportMediaEngineFailure('trailer', 'exhausted');
    expect(warn.mock.calls).toEqual([
      ['den: media engine failure', 'trailer', 'exhausted', 'none'],
    ]);
    warn.mockRestore();
  });
});
