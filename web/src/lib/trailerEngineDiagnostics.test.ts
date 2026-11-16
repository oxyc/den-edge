import { describe, expect, it, vi } from 'vitest';
import { reportTrailerEngineFailure, startTrailerEngine } from './trailerEngineDiagnostics';

describe('trailer engine diagnostics', () => {
  it('bounds a rejected dynamic import without forwarding its URL or stack', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const advance = vi.fn();
    const sentinel = new TypeError('https://provider.invalid/reel/private-capability.m3u8');
    sentinel.stack = 'private response body and title tmdb:7349281';

    await startTrailerEngine(() => Promise.reject(sentinel), vi.fn(), advance);

    expect(advance).toHaveBeenCalledOnce();
    expect(warn.mock.calls).toEqual([
      [
        '[Den trailer] {"event":"engine-failure","outcome":"module_load_failed","errorClass":"type_error"}',
      ],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(
      /provider|capability|m3u8|response body|7349281/,
    );
    warn.mockRestore();
  });

  it('bounds synchronous engine startup rejection separately from module loading', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const advance = vi.fn();
    const sentinel = new Error('chunk URL https://d.oxy.fi/assets/hls-private.js');

    await startTrailerEngine(
      async () => ({ default: 'loaded' }),
      () => {
        throw sentinel;
      },
      advance,
    );

    expect(advance).toHaveBeenCalledOnce();
    expect(warn.mock.calls).toEqual([
      ['[Den trailer] {"event":"engine-failure","outcome":"startup_failed","errorClass":"error"}'],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/chunk URL|hls-private|d\.oxy\.fi/);
    warn.mockRestore();
  });

  it('stays silent when teardown owns a late module rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const advance = vi.fn();

    await startTrailerEngine(
      () => Promise.reject(new Error('late private sentinel')),
      vi.fn(),
      advance,
      () => false,
    );

    expect(advance).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps fatal, fragment-loop and candidate-exhaustion diagnostics closed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    reportTrailerEngineFailure('fatal_error');
    reportTrailerEngineFailure('fragment_loop');
    reportTrailerEngineFailure('candidates_exhausted');

    expect(warn.mock.calls).toEqual([
      ['[Den trailer] {"event":"engine-failure","outcome":"fatal_error"}'],
      ['[Den trailer] {"event":"engine-failure","outcome":"fragment_loop"}'],
      ['[Den trailer] {"event":"engine-failure","outcome":"candidates_exhausted"}'],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(
      /url|title|capability|provider|fragment.*:/i,
    );
    warn.mockRestore();
  });
});
