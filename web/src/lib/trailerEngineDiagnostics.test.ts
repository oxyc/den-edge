import { describe, expect, it, vi } from 'vitest';
import {
  MOST_TRAILER_FRAGMENT_LOADS,
  reportTrailerEngineFailure,
  startTrailerEngine,
  trailerEngineFailureHandlers,
} from './trailerEngineDiagnostics';

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

  it('keeps nonfatal events silent and makes fatal fallback closed and one-shot', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let current = true;
    const stop = vi.fn();
    const advance = vi.fn();
    const handlers = trailerEngineFailureHandlers({
      current: () => current,
      retire: () => {
        current = false;
      },
      stop,
      advance,
    });

    handlers.error('error', { fatal: false });
    expect(warn).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();

    handlers.error('error', { fatal: true });
    handlers.error('duplicate', { fatal: true });

    expect(warn.mock.calls).toEqual([
      ['[Den trailer] {"event":"engine-failure","outcome":"fatal_error"}'],
    ]);
    expect(stop).not.toHaveBeenCalled();
    expect(advance).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('stops and advances only after the same fragment exceeds its retry allowance', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let current = true;
    const stop = vi.fn();
    const advance = vi.fn();
    const handlers = trailerEngineFailureHandlers({
      current: () => current,
      retire: () => {
        current = false;
      },
      stop,
      advance,
    });
    const sentinel = { frag: { type: 'main-private', level: 7349281, sn: 'capability-secret' } };

    for (let count = 0; count < MOST_TRAILER_FRAGMENT_LOADS; count += 1)
      handlers.fragmentLoading('loading', sentinel);
    expect(warn).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();

    handlers.fragmentLoading('loading', sentinel);
    handlers.fragmentLoading('duplicate', sentinel);

    expect(warn.mock.calls).toEqual([
      ['[Den trailer] {"event":"engine-failure","outcome":"fragment_loop"}'],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/main-private|7349281|capability-secret/);
    expect(stop).toHaveBeenCalledOnce();
    expect(advance).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('reports candidate exhaustion without candidate identity', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    reportTrailerEngineFailure('candidates_exhausted');
    expect(warn.mock.calls).toEqual([
      ['[Den trailer] {"event":"engine-failure","outcome":"candidates_exhausted"}'],
    ]);
    warn.mockRestore();
  });
});
