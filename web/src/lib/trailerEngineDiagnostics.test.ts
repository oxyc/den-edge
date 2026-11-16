import { describe, expect, it, vi } from 'vitest';
import { reportTrailerEngineFailure } from './trailerEngineDiagnostics';

describe('trailer engine diagnostics', () => {
  it('bounds a rejected dynamic import without forwarding its URL or stack', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sentinel = new TypeError('https://provider.invalid/reel/private-capability.m3u8');
    sentinel.stack = 'private response body and title tmdb:7349281';

    reportTrailerEngineFailure('startup', sentinel);

    expect(warn.mock.calls).toEqual([['den: trailer engine failure', 'startup', 'type_error']]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(
      /provider|capability|m3u8|response body|7349281/,
    );
    warn.mockRestore();
  });

  it('bounds a non-TypeError engine startup rejection', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sentinel = new Error('chunk URL https://d.oxy.fi/assets/hls-private.js');

    reportTrailerEngineFailure('startup', sentinel);

    expect(warn.mock.calls).toEqual([['den: trailer engine failure', 'startup', 'exception']]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/chunk URL|hls-private|d\.oxy\.fi/);
    warn.mockRestore();
  });

  it('keeps terminal HLS outcomes closed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    reportTrailerEngineFailure('fatal');
    reportTrailerEngineFailure('fragment_loop');

    expect(warn.mock.calls).toEqual([
      ['den: trailer engine failure', 'fatal', 'none'],
      ['den: trailer engine failure', 'fragment_loop', 'none'],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/main-private|7349281|capability-secret/);
    warn.mockRestore();
  });

  it('reports candidate exhaustion without candidate identity', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    reportTrailerEngineFailure('exhausted');
    expect(warn.mock.calls).toEqual([['den: trailer engine failure', 'exhausted', 'none']]);
    warn.mockRestore();
  });
});
