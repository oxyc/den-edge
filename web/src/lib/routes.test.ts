import { describe, expect, it } from 'vitest';
import { fetchRoutes, within } from './routes';

describe('fetchRoutes', () => {
  it('reads den-edge’s table, and is empty when it has none', async () => {
    const answer = (body: string, status = 200): typeof fetch => async () => new Response(body, { status });
    const table = '{"v":1,"addons":{"scout":[{"url":"https://pve.example:8443/scout"},{"url":"https://d-scout.oxy.fi","access":true},3]}}';
    expect(await fetchRoutes(answer(table))).toEqual({
      scout: [
        { url: 'https://pve.example:8443/scout', access: false },
        { url: 'https://d-scout.oxy.fi', access: true },
      ],
    });
    expect(await fetchRoutes(answer('<!doctype html>'))).toEqual({});
    expect(await fetchRoutes(answer('{}', 404))).toEqual({});
  });
});

describe('within', () => {
  it('is the rest of a URL past the entry it is on', () => {
    const entries = [{ url: 'http://192.168.86.193:8080' }, { url: 'https://pve.example:8443/scout' }];
    expect(within('http://192.168.86.193:8080/cfg', entries)).toBe('/cfg');
    expect(within('https://pve.example:8443/scout/cfg', entries)).toBe('/cfg');
    expect(within('https://pve.example:8443/scoutx/cfg', entries), 'a whole path segment').toBeNull();
    expect(within('https://elsewhere.example/cfg', entries)).toBeNull();
    expect(within('https://elsewhere.example/cfg')).toBeNull();
  });
});
