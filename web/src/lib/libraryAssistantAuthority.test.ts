import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import {
  APPLIED_ROW,
  DROPBOX_ROW,
  GRANTS_ROW,
  READ_ROW,
  LibraryAssistantAuthority,
  resetAssistantRows,
  type AssistantPort,
  type AssistantRecords,
} from './libraryAssistantAuthority';
import type { LibraryCommand } from './libraryServiceProtocol';
import type { ConfigValue, SettingsRow, Stamp } from './wire';

// den-spec's vectors: a request sealed by the `grant` key to the `dropbox` key, for `library`, at `now`.
const vectors = JSON.parse(
  readFileSync(new URL('../../../spec/vectors/assistant-v1.json', import.meta.url), 'utf8'),
) as {
  fixed: {
    library: string;
    now: number;
    keys: Record<string, { seed: string; id?: string; kid?: string; public: string }>;
    request: { sealed: string; fields: { id: string; at: number; args: unknown } };
  };
};
const { fixed } = vectors;
const DEVICE = '0123456789abcdef';
const DAY = 24 * 60 * 60 * 1000;

/** The library's rows, shared between the devices of one test as den-edge's log would share them. */
function library() {
  const rows = new Map<string, SettingsRow>();
  /** Each batch as it would reach den-edge: the settings it wrote, and whether an effect went with them. */
  const batches: Array<{ settings: string[]; effect: boolean }> = [];
  let tick = 0;
  return {
    rows,
    batches,
    /** The library's v4 documents, what a projection is built from (§15). */
    documents: [] as unknown[],
    /** den-edge's projections by grant, and every PUT and DELETE it was sent, in order. */
    projections: new Map<string, string[]>(),
    sent: [] as string[],
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
  const commands: Array<{ command: LibraryCommand; operationId: string; stamp: Stamp }> = [];
  const put = vi.fn(async () => true);
  let records: AssistantRecords | null = null;
  let now = fixed.now;
  /** Set while a command runs inside `ride`: the entry riding with it. */
  let riding: string[] | null = null;
  const port: AssistantPort = {
    libraryId: fixed.library,
    device: DEVICE,
    settings: (name) => shared.rows.get(name),
    refresh: async () => {},
    command: async (command, operationId, stamp) => {
      commands.push({ command, operationId, stamp });
      shared.batches.push({ settings: riding ?? [], effect: true });
      riding = null;
      return { outcome: 'applied', delivery: 'synced', affected: [{ kind: 'overview' }] };
    },
    ride: async (name, changes, work) => {
      riding = Object.keys(changes).map((setting) => `${name}:${setting}`);
      const result = await work();
      shared.patch(name, changes);
      if (riding) shared.batches.push({ settings: riding, effect: false });
      riding = null;
      return result;
    },
    loadShape: async () => true,
    seasonEpisodes: async () => [1, 2, 3],
    patch: async (name, changes) => {
      shared.patch(name, changes);
      shared.batches.push({
        settings: Object.keys(changes).map((s) => `${name}:${s}`),
        effect: false,
      });
      return [];
    },
    replace: async (row) => void shared.rows.set(row.name, row),
    putDropbox: put,
    documents: () => shared.documents,
    layouts: () => ({}),
    head: () => 7,
    putProjection: async (grant, parts) => {
      shared.projections.set(grant, parts);
      shared.sent.push(`put:${grant}`);
      return true;
    },
    deleteProjection: async (grant) => {
      shared.projections.delete(grant);
      shared.sent.push(`delete:${grant}`);
      return true;
    },
    loadRecords: async () => records && structuredClone(records),
    saveRecords: async (next) => void (records = structuredClone(next)),
    now: () => now,
    // A projection's randomness may run out of scripted values: then any 32 bytes do.
    random: () => randoms.shift() ?? '11'.repeat(32),
    ...overrides,
  };
  return {
    authority: new LibraryAssistantAuthority(port),
    commands,
    put,
    records: () => records,
    later: (ms: number) => void (now += ms),
  };
}

const seed = (name: string) => fixed.keys[name]!.seed;
const GRANT = fixed.keys.grant!.id!;
const WRITE = { write: true, read: false };

/** A library a member has consented in: the vectors' drop-box key and grant. */
async function consented() {
  const shared = library();
  await device(shared, [seed('dropbox'), seed('grant')]).authority.consent('Claude', WRITE);
  shared.batches.length = 0;
  return shared;
}

test('consent writes the drop-box key and the grant, hands den-edge the public key, and keeps no secret', async () => {
  const shared = library();
  const { authority, put } = device(shared, [seed('dropbox'), seed('grant')]);
  const { grant, key } = await authority.consent('Claude', WRITE);
  expect(grant).toBe(GRANT);
  expect(put).toHaveBeenCalledWith({
    kid: fixed.keys.dropbox!.kid,
    public: fixed.keys.dropbox!.public,
  });
  const value = shared.rows.get(GRANTS_ROW)!.values[grant]!.value as { string: string };
  expect(JSON.parse(value.string)).toMatchObject({
    client: 'Claude',
    revokedAt: null,
    cap: 100,
    expiresAt: fixed.now + 30 * DAY,
  });
  // The grant's private key is returned for den-edge and written nowhere.
  expect(JSON.stringify([...shared.rows.values()])).not.toContain(key);
  expect(Object.keys(shared.rows.get(DROPBOX_ROW)!.values)).toEqual([
    `dropbox.${fixed.keys.dropbox!.kid}`,
  ]);
  // The drop-box key's row lands before den-edge is given its public half, and the grant after it.
  expect(shared.batches.map((b) => b.settings[0]?.split(':')[0])).toEqual([
    DROPBOX_ROW,
    GRANTS_ROW,
  ]);

  // A second consent keeps the library's drop-box key.
  const second = device(shared, [seed('other')]);
  await second.authority.consent('ChatGPT', WRITE);
  expect(Object.keys(shared.rows.get(DROPBOX_ROW)!.values)).toHaveLength(1);
  expect(Object.keys(shared.rows.get(GRANTS_ROW)!.values)).toHaveLength(2);
});

test('a drop-box key den-edge did not take stops the consent before any grant is written', async () => {
  const shared = library();
  const { authority } = device(shared, [seed('dropbox'), seed('grant')], {
    putDropbox: async () => false,
  });
  await expect(authority.consent('Claude', WRITE)).rejects.toThrow();
  expect(shared.rows.get(GRANTS_ROW)).toBeUndefined();
});

test('an accepted request is the tap, at the request’s own time, recorded in the same batch, and refused again', async () => {
  const shared = await consented();
  const { authority, commands, records } = device(shared, []);
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
  // Exactly the command an episode's own Seen sends, stamped as of the request.
  expect(commands).toEqual([
    {
      command: {
        kind: 'episode-watched.set',
        episode: { type: 'tv', id: 1399, season: 1, episode: 2 },
        watched: true,
      },
      operationId: `assistant:${fixed.request.fields.id}`,
      stamp: [fixed.request.fields.at, 0, DEVICE],
    },
  ]);
  // One batch: the effect, with the applied entry riding on it.
  expect(shared.batches).toEqual([
    { settings: [`${APPLIED_ROW}:${fixed.request.fields.id}`], effect: true },
  ]);
  expect(Object.keys(shared.rows.get(APPLIED_ROW)!.values)).toEqual([fixed.request.fields.id]);
  expect(Object.keys(records()!.applied)).toEqual([fixed.request.fields.id]);

  const again = await authority.apply([{ seq: 8, sealed: fixed.request.sealed }]);
  expect(again.results).toEqual([{ seq: 8, outcome: 'rejected', reason: 'replay' }]);
  expect(again.ack).toBe(8);
  expect(commands).toHaveLength(1);
});

test('this device’s own records hold against an older row den-edge serves later', async () => {
  const shared = await consented();
  const { authority, commands } = device(shared, []);
  await authority.apply([{ seq: 1, sealed: fixed.request.sealed }]);
  // den-edge rolls the applied row back: this device still refuses the replay.
  shared.rows.delete(APPLIED_ROW);
  expect((await authority.apply([{ seq: 2, sealed: fixed.request.sealed }])).results[0]).toEqual({
    seq: 2,
    outcome: 'rejected',
    reason: 'replay',
  });

  // A revocation this device saw, then a grants row from before it.
  const before = structuredClone(shared.rows.get(GRANTS_ROW)!);
  const other = await consented();
  const { authority: second } = device(other, []);
  expect(await second.revoke(GRANT)).toBe('revoked');
  other.rows.set(GRANTS_ROW, before);
  expect((await second.apply([{ seq: 3, sealed: fixed.request.sealed }])).results[0]).toMatchObject(
    { reason: 'revoked' },
  );
  expect(commands).toHaveLength(1);
});

test('a revoked grant stops what is still queued, and a request that cannot be applied stays queued', async () => {
  const shared = await consented();
  const failing = device(shared, [], {
    command: async () => {
      throw new Error('offline');
    },
  });
  const later = await failing.authority.apply([{ seq: 1, sealed: fixed.request.sealed }]);
  expect(later).toMatchObject({ results: [], ack: null });
  expect(shared.rows.get(APPLIED_ROW)).toBeUndefined();
  // Nothing of it was kept, so this device does not take it as applied.
  expect(failing.records()!.applied).toEqual({});

  const { authority, commands } = device(shared, []);
  expect(await authority.revoke(GRANT)).toBe('revoked');
  expect(await authority.revoke('00000000000000000000000000000000')).toBe('absent');
  const refused = await authority.apply([{ seq: 1, sealed: fixed.request.sealed }]);
  expect(refused.results).toEqual([{ seq: 1, outcome: 'rejected', reason: 'revoked' }]);
  expect(refused.ack).toBe(1);
  expect(commands).toEqual([]);
});

test('a request from the future is logged loudly and never acknowledged', async () => {
  const shared = await consented();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { authority, later } = device(shared, []);
  later(-10 * 60 * 1000);
  const outcome = await authority.apply([
    { seq: 4, sealed: 'AAAA' },
    { seq: 5, sealed: fixed.request.sealed },
    { seq: 6, sealed: 'AAAA' },
  ]);
  expect(outcome.results.find((r) => r.seq === 5)).toEqual({
    seq: 5,
    outcome: 'rejected',
    reason: 'from_future',
  });
  // Up to the one before it: 6 comes again and is refused again, harmlessly.
  expect(outcome.ack).toBe(4);
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});

test('two devices applying one request at once leave one applied entry and the same library', async () => {
  const shared = await consented();
  const a = device(shared, []);
  const b = device(shared, []);
  const [first, second] = await Promise.all([
    a.authority.apply([{ seq: 1, sealed: fixed.request.sealed }]),
    b.authority.apply([{ seq: 1, sealed: fixed.request.sealed }]),
  ]);
  // Neither saw the other's entry before it opened the request: both performed the same idempotent Seen, at the same
  // stamp time, under the same operation id, so the library and the tracker end the same.
  for (const outcome of [first, second]) expect(outcome.results[0]?.outcome).toBe('accepted');
  expect(a.commands.map((c) => [c.command, c.operationId, c.stamp[0]])).toEqual(
    b.commands.map((c) => [c.command, c.operationId, c.stamp[0]]),
  );
  expect(Object.keys(shared.rows.get(APPLIED_ROW)!.values)).toEqual([fixed.request.fields.id]);
  const c = device(shared, []);
  expect(
    (await c.authority.apply([{ seq: 1, sealed: fixed.request.sealed }])).results[0],
  ).toMatchObject({ reason: 'replay' });
});

test('renewal moves a listed grant’s expiry on, at most once a day, and never un-revokes', async () => {
  const shared = await consented();
  const { authority, later } = device(shared, []);
  const expiry = () =>
    JSON.parse((shared.rows.get(GRANTS_ROW)!.values[GRANT]!.value as { string: string }).string)
      .expiresAt as number;
  later(10 * DAY);
  expect(await authority.renew([GRANT, '00000000000000000000000000000000'])).toBe(1);
  expect(expiry()).toBe(fixed.now + 40 * DAY);
  later(DAY / 2);
  expect(await authority.renew([GRANT])).toBe(0);
  expect(expiry()).toBe(fixed.now + 40 * DAY);

  await authority.revoke(GRANT);
  later(DAY);
  await authority.renew([GRANT]);
  const listed = await authority.grants();
  expect(listed.grants).toEqual([expect.objectContaining({ grant: GRANT, state: 'revoked' })]);
});

test('Settings lists every grant from the row, and a revoked one joins this device’s set', async () => {
  const shared = await consented();
  const { authority, records } = device(shared, []);
  expect((await authority.grants()).grants).toEqual([
    expect.objectContaining({ grant: GRANT, client: 'Claude', state: 'active' }),
  ]);
  // Revoked by another device: this one learns of it by reading the row.
  await device(shared, []).authority.revoke(GRANT);
  expect((await authority.grants()).grants[0]?.state).toBe('revoked');
  expect(records()!.revoked).toEqual([GRANT]);
});

test('a key reset carries no drop-box key, and every grant and read record revoked', async () => {
  const shared = await consented();
  await device(shared, [seed('other'), seed('limited')]).authority.consent('Reader', {
    write: false,
    read: true,
  });
  shared.patch(APPLIED_ROW, { [fixed.request.fields.id]: { string: '{}' } });
  const { rows, revoked } = resetAssistantRows([...shared.rows.values()], fixed.now + 1);
  expect(rows.map((row) => row.kind === 'set' && row.name).sort()).toEqual([
    APPLIED_ROW,
    GRANTS_ROW,
    READ_ROW,
  ]);
  const reader = fixed.keys.other!.id!;
  expect(revoked.sort()).toEqual([GRANT, reader].sort());
  for (const [name, id] of [
    [GRANTS_ROW, GRANT],
    [READ_ROW, reader],
  ] as const) {
    const row = rows.find((r) => r.kind === 'set' && r.name === name) as SettingsRow;
    expect(JSON.parse((row.values[id]!.value as { string: string }).string).revokedAt).toBe(
      fixed.now + 1,
    );
  }
});

// ---- reads (§15)

const READ_ONLY = { write: false, read: true };

test('a read-only consent writes a read record and no grant, so it can never write', async () => {
  const shared = library();
  const { authority, put } = device(shared, [seed('other'), seed('limited')]);
  const { grant, key, readKey } = await authority.consent('Reader', READ_ONLY);
  expect(grant).toBe(fixed.keys.other!.id);
  expect(key).toBeTruthy();
  expect(readKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(shared.rows.get(GRANTS_ROW)).toBeUndefined();
  expect(shared.rows.get(DROPBOX_ROW)).toBeUndefined();
  expect(put).not.toHaveBeenCalled();
  const record = JSON.parse(
    (shared.rows.get(READ_ROW)!.values[grant]!.value as { string: string }).string,
  );
  expect(record).toMatchObject({ client: 'Reader', key: readKey, revokedAt: null });
  // The grant key is returned for den-edge and written nowhere.
  expect(JSON.stringify([...shared.rows.values()])).not.toContain(key);
  expect((await authority.grants()).reads).toEqual([
    expect.objectContaining({ grant, client: 'Reader', state: 'active' }),
  ]);
});

test('a read-and-write consent writes both, under one grant', async () => {
  const shared = library();
  const { authority } = device(shared, [seed('dropbox'), seed('grant'), seed('limited')]);
  const { grant, readKey } = await authority.consent('Claude', { write: true, read: true });
  expect(grant).toBe(GRANT);
  expect(readKey).toBeTruthy();
  expect(Object.keys(shared.rows.get(GRANTS_ROW)!.values)).toEqual([GRANT]);
  expect(Object.keys(shared.rows.get(READ_ROW)!.values)).toEqual([GRANT]);
  // Renewing renews both, and revoking revokes both.
  const renewer = device(shared, []);
  renewer.later(10 * DAY);
  expect(await renewer.authority.renew([GRANT])).toBe(2);
  expect(await authority.revoke(GRANT)).toBe('revoked');
  const listed = await authority.grants();
  expect([listed.grants[0]?.state, listed.reads[0]?.state]).toEqual(['revoked', 'revoked']);
});

test('a projection is published for a live read grant, debounced, heartbeated, and deleted once revoked', async () => {
  const shared = library();
  const { authority, later } = device(shared, [seed('other'), seed('limited')]);
  const { grant } = await authority.consent('Reader', READ_ONLY);
  expect(await authority.publish()).toEqual([grant]);
  expect(shared.projections.get(grant)!.length).toBeGreaterThan(0);
  // Unchanged: nothing more until the heartbeat.
  later(60_000);
  expect(await authority.publish()).toEqual([]);
  later(15 * 60_000);
  expect(await authority.publish()).toEqual([grant]);
  // Revoked: den-edge is asked to drop it, once, and nothing is published for it.
  await authority.revoke(grant);
  shared.sent.length = 0;
  expect(await authority.publish()).toEqual([]);
  expect(await authority.publish()).toEqual([]);
  expect(shared.sent.filter((s) => s === `delete:${grant}`).length).toBeLessThanOrEqual(1);
  expect(shared.projections.has(grant)).toBe(false);
});

test('a library with no read records builds no projection at all', async () => {
  const shared = await consented();
  const { authority } = device(shared, []);
  expect(await authority.publish()).toEqual([]);
  expect(shared.sent).toEqual([]);
});
