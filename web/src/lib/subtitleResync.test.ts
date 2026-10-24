import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Session } from './remux';
import { checkSubtitleResync, resyncSubtitle } from './subtitleResync';

const base = `/remux/s/${'a'.repeat(22)}/${'b'.repeat(22)}`;
const session = {
  playlist: `${base}/master.m3u8`,
  audioTrack: 1,
  subtitleResync: { supported: true, url: `${base}/subtitle-resync` },
} as Session;
const track = { language: 'en', name: 'English', rendition: 2, resyncSupported: true };
const signal = () => new AbortController().signal;
const vtt = 'WEBVTT\n\n00:00:02.000 --> 00:00:10.000\nAligned\n';
beforeEach(() =>
  vi.stubGlobal('location', { origin: 'https://den.example', href: 'https://den.example/' }),
);
afterEach(() => vi.unstubAllGlobals());

test('uses the audible session audio and fetches only its aligned rendition before returning a blob', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ url: `${base}/sub2.aligned.vtt`, offsetMs: -1500, viaSparse: true }),
    )
    .mockResolvedValueOnce(new Response(vtt));
  const result = await resyncSubtitle(session, track, signal(), fetcher);
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
    rendition: 2,
    audioTrack: 1,
  });
  expect(fetcher.mock.calls[1]![0]).toBe(`https://den.example${base}/sub2.aligned.vtt`);
  expect(fetcher.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
  expect(await result.blob.text()).toBe(vtt);
  expect(result.offset).toBe(-1.5);
});

test('candidate checks never request alignment and suppress hash-exact or built-in tracks', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ supported: true, source: 'opensubtitles', hashMatch: true }),
    )
    .mockResolvedValueOnce(Response.json({ supported: true, source: 'built-in', hashMatch: false }))
    .mockResolvedValueOnce(
      Response.json({ supported: true, source: 'opensubtitles', hashMatch: false }),
    );
  expect(await checkSubtitleResync(session, track, signal(), fetcher)).toBe(false);
  expect(await checkSubtitleResync(session, track, signal(), fetcher)).toBe(false);
  expect(await checkSubtitleResync(session, track, signal(), fetcher)).toBe(true);
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
    rendition: 2,
    audioTrack: 1,
    checkOnly: true,
  });
});

test.each([
  'https://provider.example/private-source',
  `${base}/sub3.aligned.vtt`,
  `${base}/sub2.aligned.vtt?source=private`,
  `/remux/s/${'c'.repeat(22)}/${'d'.repeat(22)}/sub2.aligned.vtt`,
])('refuses an unsafe or different-session result without fetching it: %s', async (url) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ url, offsetMs: 1 }));
  await expect(resyncSubtitle(session, track, signal(), fetcher)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('never sends a control to an external origin or a different playback session', async () => {
  const fetcher = vi.fn<typeof fetch>();
  for (const url of [
    `https://elsewhere.example${base}/subtitle-resync`,
    `${base.replace('aaaa', 'cccc')}/subtitle-resync`,
  ]) {
    await expect(
      resyncSubtitle(
        { ...session, subtitleResync: { supported: true, url } },
        track,
        signal(),
        fetcher,
      ),
    ).rejects.toThrow();
  }
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([
  new Response('<html>upstream failure</html>'),
  new Response(vtt, { headers: { 'x-den-degraded': 'fallback' } }),
  new Response(vtt, { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }),
  new Response('WEBVTT\n\n'),
])('refuses unusable sidecars before changing playback', async (response) => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ url: `${base}/sub2.aligned.vtt`, offsetMs: 0 }))
    .mockResolvedValueOnce(response);
  await expect(resyncSubtitle(session, track, signal(), fetcher)).rejects.toThrow();
});
