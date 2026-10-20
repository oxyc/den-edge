import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { directSubtitles } from './directSubtitles';

const release = { label: '1080p', filename: 'Film & Friend.mkv', size: 123 };

beforeEach(() => {
  vi.stubGlobal('location', { href: 'https://den.example/movie/1' });
  let blob = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:subtitle-${++blob}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('directSubtitles', () => {
  it('loads an indexed built-in sidecar without needing an OpenSubtitles list', async () => {
    const token = 'a'.repeat(43);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) =>
      String(input).endsWith('/cast-subtitle') && init?.method === 'POST'
        ? new Response(null, { status: 503 })
        : new Response('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n'),
    );
    const found = await directSubtitles(
      '/den/config/playback',
      { imdb: 'tt0111161', subtitleLanguages: [] },
      release,
      fetchImpl,
      undefined,
      [
        {
          value: 'torbox-sidecar:1',
          language: 'eng',
          name: 'English',
          description: 'Built-in · SUBRIP',
          source: 'built-in',
          delivery: 'sidecar',
          fallbackTorboxTrack: 1,
          url: `https://den.example/den/_sidecar/${token}/1.vtt`,
        },
      ],
    );

    expect(found?.subtitles).toEqual([
      expect.objectContaining({
        value: 'torbox-sidecar:1',
        source: 'built-in',
        fallbackTorboxTrack: 1,
      }),
    ]);
    await expect(found?.load('torbox-sidecar:1')).resolves.toMatchObject({
      value: 'torbox-sidecar:1',
      language: 'eng',
      url: 'blob:subtitle-1',
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe(`https://den.example/den/_sidecar/${token}/1.vtt`);
    found?.dispose();
  });

  it('keeps indexed built-ins when the optional OpenSubtitles list is malformed', async () => {
    const token = 'b'.repeat(43);
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).includes('/subtitles/')
        ? new Response('{broken json')
        : new Response('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n'),
    );
    const found = await directSubtitles(
      '/den/config/playback',
      { imdb: 'tt0111161', subtitleLanguages: ['en'] },
      release,
      fetchImpl,
      undefined,
      [
        {
          value: 'torbox-sidecar:1',
          language: 'en',
          name: 'English',
          source: 'built-in',
          delivery: 'sidecar',
          fallbackTorboxTrack: 1,
          url: `/den/_sidecar/${token}/1.vtt`,
        },
      ],
    );
    expect(found?.subtitles).toEqual([
      expect.objectContaining({ value: 'torbox-sidecar:1', source: 'built-in' }),
    ]);
    await expect(found?.load('torbox-sidecar:1')).resolves.toMatchObject({ language: 'en' });
    found?.dispose();
  });

  it('lists every ranked candidate by preferred language, then lazily owns only chosen blobs', async () => {
    const bodies = new Map([
      [
        'https://den.example/den/~a1b2c3d4/subtitle/2.srt',
        '1\r\n00:00:01,000 --> 00:00:02,500\r\nHej!\r\n',
      ],
      [
        'https://den.example/den/~a1b2c3d4/subtitle/1.srt',
        '1\n00:00:01,000 --> 00:00:02,500\nHello!\n',
      ],
      [
        'https://den.example/den/~a1b2c3d4/subtitle/3.srt',
        '1\n00:00:01,000 --> 00:00:02,500\nHello from the second release!\n',
      ],
    ]);
    let staged = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('/subtitles/'))
        return new Response(
          JSON.stringify({
            subtitles: [
              {
                lang: 'en',
                release: 'English first',
                hashMatch: true,
                trusted: true,
                downloads: 12_400,
                url: '/den/~a1b2c3d4/subtitle/1.srt',
              },
              { lang: 'en', release: 'English second', url: '/den/~a1b2c3d4/subtitle/3.srt' },
              { lang: 'sv-SE', release: 'Swedish', url: '/den/~a1b2c3d4/subtitle/2.srt' },
            ],
          }),
        );
      if (url.endsWith('/cast-subtitle') && init?.method === 'POST') {
        staged += 1;
        return Response.json({
          url: `https://cast.example/subtitle/${String(staged).padStart(64, 'a')}.vtt`,
        });
      }
      return new Response(bodies.get(url) ?? '', { status: bodies.has(url) ? 200 : 404 });
    });

    const found = await directSubtitles(
      '/den/~a1b2c3d4/playback',
      { imdb: 'tt0111161', subtitleLanguages: ['sv', 'en', 'sv'] },
      release,
      fetchImpl,
    );

    expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
      '/den/~a1b2c3d4/subtitles/movie/tt0111161/filename=Film%20%26%20Friend.mkv&videoSize=123.json',
    ]);
    expect(found).toMatchObject({
      subtitles: [
        {
          language: 'sv',
          name: 'Swedish',
          description: 'OpenSubtitles · Swedish',
          value: 'opensubtitles:2',
        },
        {
          language: 'en',
          name: 'English',
          description: 'OpenSubtitles · English first · ✓ Exact match · Trusted · 12.4K downloads',
          value: 'opensubtitles:0',
        },
        {
          language: 'en',
          name: 'English',
          description: 'OpenSubtitles · English second',
          value: 'opensubtitles:1',
        },
      ],
      tracks: [],
    });
    await expect(found?.load('sv')).resolves.toMatchObject({
      language: 'sv',
      name: 'Swedish',
      value: 'opensubtitles:2',
      url: 'blob:subtitle-1',
      castUrl: `https://cast.example/subtitle/${'a'.repeat(63)}1.vtt`,
    });
    await found?.load('sv');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await expect(found?.load('en')).resolves.toMatchObject({
      language: 'en',
      url: 'blob:subtitle-2',
      castUrl: `https://cast.example/subtitle/${'a'.repeat(63)}2.vtt`,
    });
    await expect(found?.load('opensubtitles:1')).resolves.toMatchObject({
      language: 'en',
      value: 'opensubtitles:1',
      url: 'blob:subtitle-3',
      castUrl: `https://cast.example/subtitle/${'a'.repeat(63)}3.vtt`,
    });
    expect(fetchImpl.mock.calls.map(([input]) => String(input)).slice(1)).toEqual([
      'https://den.example/den/~a1b2c3d4/subtitle/2.srt',
      '/den/~a1b2c3d4/cast-subtitle',
      'https://den.example/den/~a1b2c3d4/subtitle/1.srt',
      '/den/~a1b2c3d4/cast-subtitle',
      'https://den.example/den/~a1b2c3d4/subtitle/3.srt',
      '/den/~a1b2c3d4/cast-subtitle',
    ]);
    const blobs = vi.mocked(URL.createObjectURL).mock.calls.map(([blob]) => blob as Blob);
    await expect(blobs[0]!.text()).resolves.toContain('00:00:01.000 --> 00:00:02.500');
    found?.dispose();
    found?.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  });

  it('cancels a subtitle body as soon as streaming crosses the 2 MiB ceiling', async () => {
    const cancel = vi.fn();
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel,
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).includes('/subtitles/')
        ? new Response(
            JSON.stringify({ subtitles: [{ lang: 'en', url: '/den/config/subtitle/1.srt' }] }),
          )
        : new Response(oversized),
    );
    const found = await directSubtitles(
      '/den/config/playback',
      { imdb: 'tt0111161', subtitleLanguages: ['en'] },
      release,
      fetchImpl,
    );
    await expect(found?.load('en')).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    found?.dispose();
  });

  it('keeps dialogue carried by formatting runs instead of dropping the styled cue', async () => {
    const styled =
      '1\n00:00:01,000 --> 00:00:02,500\n<i>Off-screen voice</i>\n\n' +
      '2\n00:00:03,000 --> 00:00:04,500\n<font color="#ffff00">Narration</font>\n';
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).includes('/subtitles/')
        ? Response.json({
            subtitles: [{ lang: 'en', url: '/den/config/subtitle/styled.srt' }],
          })
        : String(input).endsWith('/cast-subtitle')
          ? new Response(null, { status: 503 })
          : new Response(styled),
    );
    const found = await directSubtitles(
      '/den/config/playback',
      { imdb: 'tt0111161', subtitleLanguages: ['en'] },
      release,
      fetchImpl,
    );

    await expect(found?.load('en')).resolves.toMatchObject({ language: 'en' });
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)?.[0] as Blob;
    const rendered = await blob.text();
    expect(rendered).toContain('<i>Off-screen voice</i>');
    expect(rendered).toContain('<font color="#ffff00">Narration</font>');
    expect(rendered).toContain('00:00:03.000 --> 00:00:04.500');
    found?.dispose();
  });

  it('cancels a candidate list as soon as streaming crosses its 256 KiB ceiling', async () => {
    const cancel = vi.fn();
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(256 * 1024));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel,
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(oversized));
    await expect(
      directSubtitles(
        '/den/config/playback',
        { imdb: 'tt0111161', subtitleLanguages: ['en'] },
        release,
        fetchImpl,
      ),
    ).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('does not fetch a candidate outside the Den relay', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).includes('/subtitles/')
        ? new Response(
            JSON.stringify({
              subtitles: [{ lang: 'en', url: 'https://third-party.example/subtitle.srt' }],
            }),
          )
        : new Response('should not be reached'),
    );
    await expect(
      directSubtitles(
        '/den/config/playback',
        { imdb: 'tt0111161', subtitleLanguages: ['en'] },
        release,
        fetchImpl,
      ),
    ).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
