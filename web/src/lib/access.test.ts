import { describe, expect, it } from 'vitest';
import { accessOrigins } from './access';

describe('accessOrigins', () => {
  it('reads den-edge’s list, and is empty when it has none', async () => {
    const answer = (body: string, status = 200): typeof fetch => async () => new Response(body, { status });
    expect(await accessOrigins(answer('{"access":["https://d-scout.oxy.fi",3]}'))).toEqual(new Set(['https://d-scout.oxy.fi']));
    expect(await accessOrigins(answer('<!doctype html>'))).toEqual(new Set());
    expect(await accessOrigins(answer('{}', 404))).toEqual(new Set());
  });
});
