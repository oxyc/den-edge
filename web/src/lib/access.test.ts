import { describe, expect, it } from 'vitest';
import { webConfig } from './access';

describe('webConfig', () => {
  it('reads den-edge’s addon origins and den-remux’s, and is empty when it has neither', async () => {
    const answer = (body: string, status = 200): typeof fetch => async () => new Response(body, { status });
    expect(await webConfig(answer('{"access":["https://d-scout.oxy.fi",3],"remux":"https://pve.example:8443"}'))).toEqual({
      access: new Set(['https://d-scout.oxy.fi']),
      remux: 'https://pve.example:8443',
    });
    expect(await webConfig(answer('{"access":[],"remux":null}'))).toEqual({ access: new Set(), remux: null });
    expect(await webConfig(answer('<!doctype html>'))).toEqual({ access: new Set(), remux: null });
    expect(await webConfig(answer('{}', 404))).toEqual({ access: new Set(), remux: null });
  });
});
