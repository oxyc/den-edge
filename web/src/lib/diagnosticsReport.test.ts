import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chunkOf,
  currentRelease,
  errorKindOf,
  hlsFatalDetail,
  hlsFatalFromMessage,
  hlsFatalTypeOf,
  identityOf,
  loadRelease,
  moduleOf,
  pageError,
  reportableLanguage,
  routeKindOf,
  sendCastReport,
  sendPageError,
  sendPlaybackOutcome,
  subtitleSourceOf,
  type CastReport,
  type PageErrorReport,
  type PlaybackOutcomeReport,
} from './diagnosticsReport';

describe('routeKindOf', () => {
  it('names only home, title and settings; everything else is other', () => {
    expect(routeKindOf({ page: 'library' })).toBe('home');
    expect(routeKindOf({ page: 'title', type: 'movie', id: 550 })).toBe('title');
    expect(routeKindOf({ page: 'settings' })).toBe('settings');
    expect(routeKindOf({ page: 'watchlist' })).toBe('other');
    expect(routeKindOf({ page: 'search', query: 'fight club' })).toBe('other');
    expect(routeKindOf(null)).toBe('other');
    expect(routeKindOf(undefined)).toBe('other');
  });
});

describe('moduleOf', () => {
  it('matches the stack’s first app-source frame against the fixed allowlist', () => {
    expect(moduleOf('Error: boom\n    at play (Player.svelte:120:4)')).toBe('player');
    expect(moduleOf('Error: boom\n    at x (Billboard.svelte:1:1)')).toBe('billboard');
    expect(moduleOf('Error: boom\n    at x (BrowseRow.svelte:1:1)')).toBe('row');
    expect(moduleOf('Error: boom\n    at x (Settings.svelte:1:1)')).toBe('settings');
    expect(moduleOf('Error: boom\n    at x (Router.svelte:1:1)')).toBe('router');
    expect(moduleOf('Error: boom\n    at x (main.ts:1:1)')).toBe('app');
  });

  it('falls back to other for a hashed production chunk or no stack at all', () => {
    expect(moduleOf('Error: boom\n    at x (index-abc123.js:1:1)')).toBe('other');
    expect(moduleOf(undefined)).toBe('other');
  });
});

describe('chunkOf', () => {
  it('names the built chunk, its content hash stripped', () => {
    expect(chunkOf('Error: boom\n    at x (Library-a1b2c3d4.js:1:1)')).toBe('Library');
    expect(chunkOf('Error: boom\n    at x (Home.js:1:1)')).toBe('Home');
  });

  it('leaves out a vendor or runtime chunk’s own lowercase name, or no stack at all', () => {
    expect(chunkOf('Error: boom\n    at x (index-abc123.js:1:1)')).toBeUndefined();
    expect(chunkOf('Error: boom\n    at x (vendor-deadbeef.js:1:1)')).toBeUndefined();
    expect(chunkOf(undefined)).toBeUndefined();
  });
});

describe('hlsFatalDetail', () => {
  it('passes through the curated hls.js details den-edge allows', () => {
    expect(hlsFatalDetail('fragLoadError')).toBe('fragLoadError');
    expect(hlsFatalDetail('bufferStalledError')).toBe('bufferStalledError');
  });

  it('narrows anything else hls.js names, or nothing, rather than sending free text', () => {
    expect(hlsFatalDetail('someDetailNotYetCurated')).toBe('other');
    expect(hlsFatalDetail(undefined)).toBeUndefined();
  });
});

describe('hlsFatalTypeOf and hlsFatalFromMessage', () => {
  it('narrows a known ErrorTypes value and buckets anything else as otherError', () => {
    expect(hlsFatalTypeOf('mediaError')).toBe('mediaError');
    expect(hlsFatalTypeOf('somethingNew')).toBe('otherError');
    expect(hlsFatalTypeOf(undefined)).toBeUndefined();
  });

  it('parses the `hls.js <type> <details>` shape Player.svelte’s broke() folds a fatal error into', () => {
    expect(hlsFatalFromMessage('hls.js mediaError fragLoadError')).toEqual({
      type: 'mediaError',
      detail: 'fragLoadError',
    });
  });

  it('is undefined for a message in no such shape, rather than a false match', () => {
    expect(hlsFatalFromMessage('Playback failed')).toBeUndefined();
    expect(hlsFatalFromMessage('no picture after 20 s with nothing arriving')).toBeUndefined();
  });
});

describe('reportableLanguage', () => {
  it('lowercases a short BCP-47-ish tag', () => {
    expect(reportableLanguage('EN')).toBe('en');
    expect(reportableLanguage('pt-BR')).toBe('pt-br');
  });

  it('leaves out anything outside the shape, rather than sending it and being refused', () => {
    expect(reportableLanguage(null)).toBeUndefined();
    expect(reportableLanguage('')).toBeUndefined();
    expect(reportableLanguage('<script>')).toBeUndefined();
    expect(reportableLanguage('way-too-long-a-tag')).toBeUndefined();
  });
});

describe('loadRelease / currentRelease', () => {
  it('reads x-den-release from a HEAD of this page’s own path', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { headers: { 'x-den-release': 'deadbeef' } }));
    await loadRelease(fetchImpl, '/movie/550-fight-club');
    expect(fetchImpl).toHaveBeenCalledWith('/movie/550-fight-club', {
      method: 'HEAD',
      cache: 'no-store',
    });
    expect(currentRelease()).toBe('deadbeef');
  });

  it('leaves the release unset, rather than throwing, when the re-fetch fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(loadRelease(fetchImpl)).resolves.toBeUndefined();
  });
});

describe('errorKindOf', () => {
  it('reads a built-in error’s real constructor', () => {
    expect(errorKindOf(new TypeError('x'))).toBe('TypeError');
    expect(errorKindOf(new ReferenceError('x'))).toBe('ReferenceError');
    expect(errorKindOf(new RangeError('x'))).toBe('RangeError');
    expect(errorKindOf(new SyntaxError('x'))).toBe('SyntaxError');
  });

  it('tells a NetworkError DOMException apart from any other named one', () => {
    expect(errorKindOf(new DOMException('x', 'NetworkError'))).toBe('NetworkError');
    expect(errorKindOf(new DOMException('x', 'AbortError'))).toBe('DOMException');
  });

  it('is other for anything else, never the (freely settable) .name or .message', () => {
    expect(errorKindOf(new Error('x'))).toBe('other');
    const spoofed = new Error('<script>evil</script>');
    spoofed.name = 'TypeError';
    expect(errorKindOf(spoofed)).toBe('other');
    expect(errorKindOf('not an error')).toBe('other');
    expect(errorKindOf(undefined)).toBe('other');
  });
});

describe('pageError', () => {
  it('leaves out errorKind and chunk with no error to read them from', () => {
    const report = pageError('render_stall', 'app');
    expect(report.errorKind).toBeUndefined();
    expect(report.chunk).toBeUndefined();
  });

  it('carries the caught error’s real kind and the chunk its stack names', () => {
    const error = new TypeError('x');
    error.stack = 'TypeError: x\n    at render (Library-a1b2c3d4.js:9:1)';
    const report = pageError('uncaught', moduleOf(error.stack), error);
    expect(report.errorKind).toBe('TypeError');
    expect(report.chunk).toBe('Library');
  });
});

describe('sendPageError', () => {
  const report: PageErrorReport = { kind: 'chunk_load', module: 'app', route: 'home' };

  it('posts to den-edge, kept alive, with the report as the body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    sendPageError(report, fetchImpl);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).toHaveBeenCalledWith('/playback/page-error', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
      keepalive: true,
    });
  });

  it('never throws when the send fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    expect(() => sendPageError(report, fetchImpl)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('identityOf', () => {
  const title = { id: 550, type: 'movie' as const };

  it('names only the title when nothing has opened yet', () => {
    expect(identityOf(title, undefined, undefined, undefined)).toEqual({
      tmdbId: 550,
      mediaType: 'movie',
      season: undefined,
      episode: undefined,
    });
  });

  it('carries the release, the chosen audio track and its language once a session is open', () => {
    const fields = identityOf(title, 2, 4, {
      release: { filename: 'Fight.Club.1999.1080p.BluRay.x264-GROUP', size: 7_654_321_000 },
      audioTrack: 1,
      audioLanguage: 'en',
    });
    expect(fields).toEqual({
      tmdbId: 550,
      mediaType: 'movie',
      season: 2,
      episode: 4,
      release: { name: 'Fight.Club.1999.1080p.BluRay.x264-GROUP', size: 7_654_321_000 },
      audioTrackIndex: 1,
      audioLanguage: 'en',
      audioCodec: 'aac',
    });
  });

  it('leaves out an audio language outside reportableLanguage’s shape', () => {
    const fields = identityOf(title, undefined, undefined, {
      release: { filename: 'x', size: 1 },
      audioTrack: 0,
      audioLanguage: '<script>',
    });
    expect(fields.audioLanguage).toBeUndefined();
    expect(fields.audioCodec).toBe('aac');
  });

  it('carries the chosen subtitle’s index, language and source, dropping a -1 index and an invalid language', () => {
    const withSubtitle = identityOf(title, undefined, undefined, undefined, {
      index: 2,
      language: 'pt-br',
      source: 'den_subtitles',
    });
    expect(withSubtitle.subtitleIndex).toBe(2);
    expect(withSubtitle.subtitleLanguage).toBe('pt-br');
    expect(withSubtitle.subtitleSource).toBe('den_subtitles');

    const noMatch = identityOf(title, undefined, undefined, undefined, {
      index: -1,
      language: '<script>',
    });
    expect(noMatch.subtitleIndex).toBeUndefined();
    expect(noMatch.subtitleLanguage).toBeUndefined();
    expect(noMatch.subtitleSource).toBeUndefined();
  });
});

describe('subtitleSourceOf', () => {
  it('says release only when no den-subtitles candidate was ever offered', () => {
    expect(subtitleSourceOf(false, true)).toBe('release');
  });

  it('cannot tell release and den-subtitles apart once a candidate was offered — unknown, not a guess', () => {
    expect(subtitleSourceOf(true, true)).toBe('unknown');
  });

  it('names no source for a session with nothing showing, candidate or not', () => {
    expect(subtitleSourceOf(false, false)).toBeUndefined();
    expect(subtitleSourceOf(true, false)).toBeUndefined();
  });
});

describe('sendPlaybackOutcome and sendCastReport', () => {
  const outcome: PlaybackOutcomeReport = {
    engine: 'hls.js',
    route: 'lan',
    stallCount: 1,
    stalledMs: 500,
    endReason: 'finished',
    secondsPlayed: 90,
  };
  const cast: CastReport = { kind: 'chromecast', reached: 'started' };
  let sendBeacon: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { ...navigator, sendBeacon });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('prefers sendBeacon, which outruns the unload it may be reporting on', () => {
    const fetchImpl = vi.fn();
    sendPlaybackOutcome(outcome, fetchImpl);
    expect(sendBeacon).toHaveBeenCalledWith('/playback/outcome', JSON.stringify(outcome));
    expect(fetchImpl).not.toHaveBeenCalled();

    sendCastReport(cast, fetchImpl);
    expect(sendBeacon).toHaveBeenCalledWith('/playback/cast', JSON.stringify(cast));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back to a kept-alive fetch when sendBeacon is absent or refuses', async () => {
    sendBeacon.mockReturnValue(false);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    sendPlaybackOutcome(outcome, fetchImpl);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).toHaveBeenCalledWith('/playback/outcome', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(outcome),
      keepalive: true,
    });
  });
});
