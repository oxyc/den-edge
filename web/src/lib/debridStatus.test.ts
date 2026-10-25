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
  it('reads a code from the cause or the error', () => {
    expect(debridPlayCodeOf({ error: 'source_unavailable', cause: 'release_uncached' })).toBe(
      'release_uncached',
    );
    expect(debridPlayCodeOf({ error: 'debrid_slow' })).toBe('debrid_slow');
    expect(
      debridPlayCodeOf({ error: 'source_unavailable', cause: 'torbox_refused' }),
    ).toBeUndefined();
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
