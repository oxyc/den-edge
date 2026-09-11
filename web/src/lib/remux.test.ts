import { describe, expect, it } from 'vitest';
import { endSession, login, startSession, type Want } from './remux';

const want: Want = {
  imdb: 'tt0111161',
  scout: 'http://192.168.86.193:8080/sealed-cfg',
  subtitles: ['http://192.168.86.193:8092/reel-cfg', 'http://192.168.86.193:8093/subs-cfg'],
  subtitleLanguages: ['en'],
  audio: ['en-US'],
  videoCodecs: ['h264'],
};
const session = { playlist: '/remux/s/sid/sig/master.m3u8', duration: 7200, release: { label: '1080p', filename: 'f.mkv', size: 1 } };
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('startSession', () => {
  it('tries each LAN addon as den-subtitles until one is, and sends what the page wants', async () => {
    const sent: Record<string, unknown>[] = [];
    const result = await startSession(want, async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      return body.subtitles === want.subtitles[1] ? answer(201, session) : answer(400, { error: 'bad_subtitles' });
    });
    expect(result).toEqual(session);
    expect(sent.map((b) => b.subtitles)).toEqual(want.subtitles);
    expect(sent[1]).toMatchObject({ imdb: 'tt0111161', scout: want.scout, audio: ['en-US'], videoCodecs: ['h264'], subtitleLanguages: ['en'] });
  });

  it('plays without subtitles when no addon is den-subtitles', async () => {
    const sent: Record<string, unknown>[] = [];
    const result = await startSession(want, async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      return body.subtitles ? answer(400, { error: 'bad_subtitles' }) : answer(201, session);
    });
    expect(result).toEqual(session);
    expect(sent.at(-1)).not.toHaveProperty('subtitles');
    expect(sent.at(-1)).not.toHaveProperty('subtitleLanguages');
  });

  it('says why a session could not start', async () => {
    const plain = { ...want, subtitleLanguages: [] };
    const failing = (status: number, error: string) => startSession(plain, async () => answer(status, { error }));
    expect(await failing(401, 'not_logged_in')).toEqual({ failure: 'login' });
    expect(await failing(404, 'no_playable_release')).toEqual({ failure: 'none' });
    expect(await failing(429, 'too_many_sessions')).toEqual({ failure: 'busy' });
    expect(await failing(503, 'transcode_unavailable')).toEqual({ failure: 'transcode' });
    expect(await failing(502, 'scout_unavailable')).toEqual({ failure: 'unreachable' });
    expect(await startSession(plain, async () => Promise.reject(new TypeError('offline')))).toEqual({ failure: 'unreachable' });
  });
});

describe('login', () => {
  it('is true for a known key, false for an unknown one, and null out of reach', async () => {
    expect(await login('k', async () => new Response(null, { status: 204 }))).toBe(true);
    expect(await login('k', async () => answer(401, { error: 'bad_key' }))).toBe(false);
    expect(await login('k', async () => Promise.reject(new TypeError('offline')))).toBeNull();
  });
});

describe('endSession', () => {
  it('deletes the session by its signed path', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    endSession(session, async (input, init) => {
      calls.push([String(input), init]);
      return new Response(null, { status: 204 });
    });
    expect(calls).toEqual([['/remux/s/sid/sig', { method: 'DELETE', keepalive: true }]]);
  });
});
