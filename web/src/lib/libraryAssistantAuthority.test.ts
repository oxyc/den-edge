import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import {
  APPLIED_ROW,
  DROPBOX_ROW,
  GRANTS_ROW,
  LibraryAssistantAuthority,
  type AssistantPort,
} from './libraryAssistantAuthority';
import type { LibraryCommand } from './libraryServiceProtocol';
import type { ConfigValue, SettingsRow } from './wire';

// den-spec's vectors: a request sealed by the `grant` key to the `dropbox` key, for `library`, at `now`.
const vectors = JSON.parse(
  readFileSync(new URL('../../../spec/vectors/assistant-v1.json', import.meta.url), 'utf8'),
) as {
  fixed: {
    library: string;
    now: number;
    keys: Record<string, { seed: string; id?: string; kid?: string; public: string }>;
    request: { sealed: string; fields: { id: string; args: unknown } };
  };
};
const { fixed } = vectors;

/** The library's rows, shared between the devices of one test as den-edge's log would share them. */
function library() {
  const rows = new Map<string, SettingsRow>();
  let tick = 0;
  return {
    rows,
    patch(name: string, changes: Record<string, ConfigValue | null>) {
      const base = rows.get(name) ?? { kind: 'set' as const, schema: 2, name, values: {} };
      const at: [number, number, string] = [fixed.now, ++tick, 'device'];
      const values = { ...base.values };
      for (const [setting, value] of Object.entries(changes)) values[setting] = { value, at };
      rows.set(name, { ...base, values });
    },
  };
}

type Library = ReturnType<typeof library>;

function device(shared: Library, randoms: string[], overrides: Partial<AssistantPort> = {}) {
  const commands: Array<{ command: LibraryCommand; operationId: string }> = [];
  const put = vi.fn(async () => true);
  const port: AssistantPort = {
    libraryId: fixed.library,
    settings: (name) => shared.rows.get(name),
    refresh: async () => {},
    command: async (command, operationId) => {
      commands.push({ command, operationId });
      return { outcome: 'applied', delivery: 'synced', affected: [{ kind: 'overview' }] };
    },
    loadShape: async () => true,
    seasonEpisodes: async () => [1, 2, 3],
    patch: async (name, changes) => {
      shared.patch(name, changes);
      return [];
    },
    replace: async (row) => void shared.rows.set(row.name, row),
    putDropbox: put,
    now: () => fixed.now,
    random: () => randoms.shift()!,
    ...overrides,
  };
  return { authority: new LibraryAssistantAuthority(port), commands, put };
}

const seed = (name: string) => fixed.keys[name]!.seed;

test('consent writes the drop-box key and the grant, hands den-edge the public key, and keeps no secret', async () => {
  const shared = library();
  const { authority, put } = device(shared, [seed('dropbox'), seed('grant')]);
  const { grant, key } = await authority.consent('Claude');
  expect(grant).toBe(fixed.keys.grant!.id);
  expect(put).toHaveBeenCalledWith({
    kid: fixed.keys.dropbox!.kid,
    public: fixed.keys.dropbox!.public,
  });
  const grants = shared.rows.get(GRANTS_ROW)!.values[grant]!.value as { string: string };
  expect(JSON.parse(grants.string)).toMatchObject({ client: 'Claude', revokedAt: null, cap: 100 });
  // The grant's private key is returned for den-edge and written nowhere.
  expect(JSON.stringify([...shared.rows.values()])).not.toContain(key);
  expect(Object.keys(shared.rows.get(DROPBOX_ROW)!.values)).toEqual([
    `dropbox.${fixed.keys.dropbox!.kid}`,
  ]);

  // A second consent keeps the library's drop-box key.
  const second = device(shared, [seed('other')]);
  await second.authority.consent('ChatGPT');
  expect(Object.keys(shared.rows.get(DROPBOX_ROW)!.values)).toHaveLength(1);
  expect(Object.keys(shared.rows.get(GRANTS_ROW)!.values)).toHaveLength(2);
});

test('a drop-box key den-edge did not take stops the consent before any grant is written', async () => {
  const shared = library();
  const { authority } = device(shared, [seed('dropbox'), seed('grant')], {
    putDropbox: async () => false,
  });
  await expect(authority.consent('Claude')).rejects.toThrow();
  expect(shared.rows.get(GRANTS_ROW)).toBeUndefined();
});

test('an accepted request is applied as the tap, recorded, and refused when it comes again', async () => {
  const shared = library();
  await device(shared, [seed('dropbox'), seed('grant')]).authority.consent('Claude');
  const { authority, commands } = device(shared, []);
  const first = await authority.apply([{ seq: 7, sealed: fixed.request.sealed }]);
  expect(first.results).toEqual([
    {
      seq: 7,
      outcome: 'accepted',
      op: 'seen',
      title: { type: 'tv', id: 1399 },
      detail: 'marked S1 · E2 of %s as seen',
    },
  ]);
  expect(first.ack).toBe(7);
  expect(first.dropbox).toEqual({
    kid: fixed.keys.dropbox!.kid,
    public: fixed.keys.dropbox!.public,
  });
  // Exactly the command an episode's own Seen sends.
  expect(commands).toEqual([
    {
      command: {
        kind: 'episode-watched.set',
        episode: { type: 'tv', id: 1399, season: 1, episode: 2 },
        watched: true,
      },
      operationId: `assistant:${fixed.request.fields.id}`,
    },
  ]);
  expect(Object.keys(shared.rows.get(APPLIED_ROW)!.values)).toEqual([fixed.request.fields.id]);

  const again = await authority.apply([{ seq: 8, sealed: fixed.request.sealed }]);
  expect(again.results).toEqual([{ seq: 8, outcome: 'rejected', reason: 'replay' }]);
  expect(again.ack).toBe(8);
  expect(commands).toHaveLength(1);
});

test('a revoked grant stops what is still queued, and a request that cannot be applied is left for later', async () => {
  const shared = library();
  await device(shared, [seed('dropbox'), seed('grant')]).authority.consent('Claude');
  const failing = device(shared, [], {
    command: async () => {
      throw new Error('offline');
    },
  });
  const later = await failing.authority.apply([{ seq: 1, sealed: fixed.request.sealed }]);
  expect(later).toMatchObject({ results: [], ack: null });
  expect(shared.rows.get(APPLIED_ROW)).toBeUndefined();

  const { authority, commands } = device(shared, []);
  expect(await authority.revoke(fixed.keys.grant!.id!)).toBe('revoked');
  expect(await authority.revoke('00000000000000000000000000000000')).toBe('absent');
  const refused = await authority.apply([{ seq: 1, sealed: fixed.request.sealed }]);
  expect(refused.results).toEqual([{ seq: 1, outcome: 'rejected', reason: 'revoked' }]);
  expect(refused.ack).toBe(1);
  expect(commands).toEqual([]);
});

test('two devices applying one request at once leave one applied entry and the same library', async () => {
  const shared = library();
  await device(shared, [seed('dropbox'), seed('grant')]).authority.consent('Claude');
  const a = device(shared, []);
  const b = device(shared, []);
  const [first, second] = await Promise.all([
    a.authority.apply([{ seq: 1, sealed: fixed.request.sealed }]),
    b.authority.apply([{ seq: 1, sealed: fixed.request.sealed }]),
  ]);
  // Neither saw the other's entry before it opened the request: both performed the same idempotent Seen, under the
  // same operation id, so the tracker hears of it once.
  for (const outcome of [first, second]) expect(outcome.results[0]?.outcome).toBe('accepted');
  expect(a.commands).toEqual(b.commands);
  expect(Object.keys(shared.rows.get(APPLIED_ROW)!.values)).toEqual([fixed.request.fields.id]);
  // Any later drain refuses it.
  const c = device(shared, []);
  expect(
    (await c.authority.apply([{ seq: 1, sealed: fixed.request.sealed }])).results[0],
  ).toMatchObject({
    reason: 'replay',
  });
});

test('a request sealed for another library, or junk, is refused and acknowledged', async () => {
  const shared = library();
  await device(shared, [seed('dropbox'), seed('grant')]).authority.consent('Claude');
  const { authority } = device(shared, []);
  const outcome = await authority.apply([
    { seq: 2, sealed: 'AAAA' },
    { seq: 1, sealed: fixed.request.sealed.slice(0, -4) + 'AAAA' },
  ]);
  expect(outcome.results.map((r) => [r.seq, r.outcome === 'rejected' && r.reason])).toEqual([
    [1, 'does_not_open'],
    [2, 'does_not_open'],
  ]);
  expect(outcome.ack).toBe(2);
});
