import { describe, expect, it } from 'vitest';
import { debridNotice, debridPlayCodeOf, debridStateOf, readDebridState } from './debridStatus';

describe('debridStateOf', () => {
  it.each(['ok', 'slow', 'down'] as const)('reads %s', (state) => {
    expect(debridStateOf({ status: 'ok', debrid: { provider: 'torbox', state } })).toBe(state);
  });

  it.each([[{ status: 'ok' }], [{ debrid: { state: 'melting' } }], [null], ['ok']])(
    'says nothing of %j',
    (health) => expect(debridStateOf(health)).toBeNull(),
  );
});

describe('debridPlayCodeOf', () => {
  const answer = (headers: Record<string, string> = {}, status = 503) =>
    new Response(null, { status, headers });

  it('leaves a refusal other than a 503 as it is, even when it names TorBox’s health', () => {
    // Hearth names a slow TorBox on a failed play's own code too (`404 no_release`): that stays a no-release answer.
    const slow = answer({ 'x-den-degraded': 'debrid_slow' }, 404);
    expect(debridPlayCodeOf(slow, { error: 'no_release' })).toBeUndefined();
  });

  it('reads TorBox’s health from X-Den-Degraded', () => {
    const body = { error: 'status_unavailable', service: 'torbox' };
    expect(debridPlayCodeOf(answer({ 'x-den-degraded': 'debrid_slow' }), body)).toBe('debrid_slow');
    expect(debridPlayCodeOf(answer({ 'x-den-degraded': 'debrid_down' }), body)).toBe('debrid_down');
    expect(debridPlayCodeOf(answer({ 'x-den-degraded': 'cache-check' }), body)).toBeUndefined();
  });

  it('reads debrid_down for TorBox, whatever the case of its service', () => {
    expect(debridPlayCodeOf(answer(), { error: 'debrid_down', service: 'TorBox' })).toBe(
      'debrid_down',
    );
    expect(debridPlayCodeOf(answer(), { error: 'debrid_down', service: 'realdebrid' })).toBe(
      undefined,
    );
    expect(debridPlayCodeOf(answer(), { error: 'source_unavailable' })).toBeUndefined();
  });
});

describe('readDebridState', () => {
  const answering = (body: unknown, asked: string[]) =>
    (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response(JSON.stringify(body));
    }) as typeof fetch;

  it('asks the playback addon’s Hearth mount', async () => {
    const asked: string[] = [];
    const fetchImpl = answering({ debrid: { state: 'down' } }, asked);
    expect(await readDebridState({ install: 'x', base: '/den/cfg' }, fetchImpl)).toBe('down');
    expect(asked).toEqual(['/den/health']);
  });

  it('asks nothing for a shared addon', async () => {
    const asked: string[] = [];
    const fetchImpl = answering({ debrid: { state: 'down' } }, asked);
    expect(await readDebridState({ install: 'x', base: '/den/~a1b2c3d4' }, fetchImpl)).toBeNull();
    expect(asked).toEqual([]);
  });

  it('is null when the read fails', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('offline');
    }) as typeof fetch;
    expect(await readDebridState({ install: 'x', base: '/den/cfg' }, fetchImpl)).toBeNull();
  });
});

it('says something only of a slow or down service', () => {
  expect(debridNotice('down')).toContain('isn’t responding');
  expect(debridNotice('slow')).toContain('slow');
  expect(debridNotice('ok')).toBeNull();
  expect(debridNotice(null)).toBeNull();
});
