import { describe, expect, it } from 'vitest';
import { accessOrigins, accessToken, withAccess } from './access';
import type { SettingsRow } from './wire';

const ORIGINS = new Set(['https://d-scout.oxy.fi', 'https://d-subs.oxy.fi', 'https://d-atlas.oxy.fi']);
const TOKEN = { id: 'client.access', secret: 's3cret' };

function recorder() {
  const sent: [string, Headers][] = [];
  const base: typeof fetch = async (input, init) => {
    sent.push([String(input), new Headers(init?.headers)]);
    return new Response('{}');
  };
  return { base, sent };
}

describe('withAccess', () => {
  it('sends the token to the Access-protected names and nowhere else', async () => {
    const { base, sent } = recorder();
    const fetchWith = withAccess(ORIGINS, TOKEN, base);
    for (const url of [
      'https://d-scout.oxy.fi/cfg/manifest.json',
      'https://d-play.oxy.fi/p/ticket',
      'http://192.168.86.193:8080/cfg/manifest.json',
      '/scout/cfg/manifest.json',
      'https://api.themoviedb.org/3/movie/1',
    ]) {
      await fetchWith(url, { headers: { accept: 'application/json' } });
    }
    const carried = sent.filter(([, h]) => h.get('cf-access-client-id') === 'client.access').map(([url]) => url);
    expect(carried).toEqual(['https://d-scout.oxy.fi/cfg/manifest.json']);
    expect(sent[0]![1].get('cf-access-client-secret')).toBe('s3cret');
    expect(sent[0]![1].get('accept'), 'the caller’s own headers stay').toBe('application/json');
  });

  it('sends nothing without a whole token', async () => {
    const { base, sent } = recorder();
    await withAccess(ORIGINS, null, base)('https://d-scout.oxy.fi/x');
    expect(sent[0]![1].has('cf-access-client-id')).toBe(false);
  });
});

describe('accessToken', () => {
  const keys = (values: Record<string, string | null>): SettingsRow => ({
    kind: 'set',
    schema: 2,
    name: 'keys',
    values: Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, { value: v === null ? null : { string: v }, at: [1, 0, 'tv01'] }]),
    ),
  });

  it('is both halves or nothing', () => {
    expect(accessToken(keys({ cfAccessId: 'a', cfAccessSecret: 'b' }))).toEqual({ id: 'a', secret: 'b' });
    expect(accessToken(keys({ cfAccessId: 'a', cfAccessSecret: null }))).toBeNull();
    expect(accessToken(undefined)).toBeNull();
  });
});

describe('accessOrigins', () => {
  it('reads den-edge’s list, and is empty when it has none', async () => {
    const answer = (body: string, status = 200): typeof fetch => async () => new Response(body, { status });
    expect(await accessOrigins(answer('{"access":["https://d-scout.oxy.fi",3]}'))).toEqual(new Set(['https://d-scout.oxy.fi']));
    expect(await accessOrigins(answer('<!doctype html>'))).toEqual(new Set());
    expect(await accessOrigins(answer('{}', 404))).toEqual(new Set());
  });
});
