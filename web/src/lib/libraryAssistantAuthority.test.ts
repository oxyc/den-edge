import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import policyCases from '../vendor/den-core/policy-v1.json';
import { expect, test, vi } from 'vitest';
import {
  APPLIED_ROW,
  DROPBOX_ROW,
  GRANTS_ROW,
  PLAY_ROW,
  READ_ROW,
  LibraryAssistantAuthority,
  randomHex,
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
/** den-core's case of a `play` (§16) sealed with the same keys, for the same library, at the same `now`. */
const playSealed = () =>
  (
    policyCases.cases.find(
      (c: { name: string }) => c.name === "assistant_open: a play moved into the library's queue",
    ) as { request: { sealed: string } }
  ).request.sealed;
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
    projections: new Map<string, { set: string; parts: string[] }>(),
    sent: [] as string[],
    /** Whose member proof each PUT and DELETE went with: a lent connection's library id, or null for its own. */
    members: [] as Array<string | null>,
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
    inputs: () => JSON.stringify([shared.documents, [...shared.rows.values()]]),
    putProjection: async (grant, set, parts, member) => {
      shared.projections.set(grant, { set, parts });
      shared.sent.push(`put:${grant}`);
      shared.members.push(member?.libraryId ?? null);
      return true;
    },
    deleteProjection: async (grant, member) => {
      shared.projections.delete(grant);
      shared.sent.push(`delete:${grant}`);
      shared.members.push(member?.libraryId ?? null);
      return true;
    },
    membership: async () => ({ libraryId: fixed.library, memberToken: 'a'.repeat(64) }),
    loadRecords: async () => records && structuredClone(records),
    saveRecords: async (next) => void (records = structuredClone(next)),
    now: () => now,
    // A projection's randomness may run out of scripted values: then any fresh 32 bytes do.
    random: () => randoms.shift() ?? randomHex(),
    ...overrides,
  };
  return {
    authority: new LibraryAssistantAuthority(port),
    commands,
    put,
    records: () => records,
    later: (ms: number) => void (now += ms),
    /** The same device opened again, as each page load opens a new library service: only its records carry over. */
    reopen: () => new LibraryAssistantAuthority(port),
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
  // The drop-box key's row lands before den-edge is given its public half, and the grant after it, then its play
  // record (§16): the one consent allows changing the library and playing on the TV.
  expect(shared.batches.map((b) => b.settings[0]?.split(':')[0])).toEqual([
    DROPBOX_ROW,
    GRANTS_ROW,
    PLAY_ROW,
  ]);
  const play = shared.rows.get(PLAY_ROW)!.values[grant]!.value as { string: string };
  expect(JSON.parse(play.string)).toMatchObject({
    v: 1,
    client: 'Claude',
    revokedAt: null,
    expiresAt: fixed.now + 30 * DAY,
  });
  expect((await authority.grants()).plays).toEqual([
    expect.objectContaining({ grant, client: 'Claude', state: 'active' }),
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
  // The grant and its play record (§16).
  expect(await authority.renew([GRANT, '00000000000000000000000000000000'])).toBe(2);
  expect(expiry()).toBe(fixed.now + 40 * DAY);
  expect((await authority.grants()).plays[0]?.expiresAt).toBe(fixed.now + 40 * DAY);
  later(DAY / 2);
  expect(await authority.renew([GRANT])).toBe(0);
  expect(expiry()).toBe(fixed.now + 40 * DAY);

  await authority.revoke(GRANT);
  later(DAY);
  await authority.renew([GRANT]);
  const listed = await authority.grants();
  expect(listed.grants).toEqual([expect.objectContaining({ grant: GRANT, state: 'revoked' })]);
  expect(listed.plays).toEqual([expect.objectContaining({ grant: GRANT, state: 'revoked' })]);
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

test('a key reset carries no drop-box key, and every grant, read and play record revoked', async () => {
  const shared = await consented();
  await device(shared, [seed('other'), seed('limited')]).authority.consent('Reader', {
    write: false,
    read: true,
  });
  shared.patch(APPLIED_ROW, { [fixed.request.fields.id]: { string: '{}' } });
  const { rows, revoked } = await resetAssistantRows([...shared.rows.values()], fixed.now + 1);
  expect(rows.map((row) => row.kind === 'set' && row.name).sort()).toEqual([
    APPLIED_ROW,
    GRANTS_ROW,
    PLAY_ROW,
    READ_ROW,
  ]);
  const reader = fixed.keys.other!.id!;
  expect(revoked.sort()).toEqual([GRANT, reader].sort());
  for (const [name, id] of [
    [GRANTS_ROW, GRANT],
    [PLAY_ROW, GRANT],
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

test('a read-and-write consent writes all three records, under one grant', async () => {
  const shared = library();
  const { authority } = device(shared, [seed('dropbox'), seed('grant'), seed('limited')]);
  const { grant, readKey } = await authority.consent('Claude', { write: true, read: true });
  expect(grant).toBe(GRANT);
  expect(readKey).toBeTruthy();
  for (const row of [GRANTS_ROW, READ_ROW, PLAY_ROW])
    expect(Object.keys(shared.rows.get(row)!.values)).toEqual([GRANT]);
  // Renewing renews all three, and revoking revokes all three.
  const renewer = device(shared, []);
  renewer.later(10 * DAY);
  expect(await renewer.authority.renew([GRANT])).toBe(3);
  expect(await authority.revoke(GRANT)).toBe('revoked');
  const listed = await authority.grants();
  expect([listed.grants[0]?.state, listed.reads[0]?.state, listed.plays[0]?.state]).toEqual([
    'revoked',
    'revoked',
    'revoked',
  ]);
});

test('a play found in the library queue is refused there and acknowledged, never applied by Den Web', async () => {
  const shared = await consented();
  const { authority } = device(shared, []);
  const outcome = await authority.apply([{ seq: 7, sealed: playSealed() }]);
  expect(outcome.results).toEqual([{ seq: 7, outcome: 'rejected', reason: 'wrong_queue' }]);
  expect(outcome.ack).toBe(7);
});

test('a read-only consent writes no play record: playing is part of the consent to change the library', async () => {
  const shared = library();
  const { authority } = device(shared, [seed('other'), seed('limited')]);
  await authority.consent('Reader', READ_ONLY);
  expect(shared.rows.get(PLAY_ROW)).toBeUndefined();
});

test('a projection is published for a live read grant, debounced, heartbeated, and deleted once revoked', async () => {
  const shared = library();
  const { authority, later } = device(shared, [seed('other'), seed('limited')]);
  const { grant } = await authority.consent('Reader', READ_ONLY);
  expect(await authority.publish()).toEqual([grant]);
  const first = shared.projections.get(grant)!;
  expect(first.set).toMatch(/^[0-9a-f]{32}$/);
  expect(first.parts.length).toBeGreaterThan(0);
  // Unchanged: nothing more until the heartbeat.
  later(60_000);
  expect(await authority.publish()).toEqual([]);
  later(15 * 60_000);
  expect(await authority.publish()).toEqual([grant]);
  // Every publish is a fresh set.
  expect(shared.projections.get(grant)!.set).not.toBe(first.set);
  // Revoked: den-edge is asked to drop it, once, and nothing is published for it.
  await authority.revoke(grant);
  shared.sent.length = 0;
  expect(await authority.publish()).toEqual([]);
  expect(await authority.publish()).toEqual([]);
  expect(shared.sent.filter((s) => s === `delete:${grant}`).length).toBeLessThanOrEqual(1);
  expect(shared.projections.has(grant)).toBe(false);
});

test('a page owes nothing to a library with no live connection, and its work follows consent and revocation', async () => {
  const shared = library();
  const { authority } = device(shared, [seed('dropbox'), seed('grant'), seed('limited')]);
  expect(await authority.needs()).toEqual({ write: false, read: false });
  const { grant } = await authority.consent('Claude', { write: true, read: true });
  expect(await authority.needs()).toEqual({ write: true, read: true });
  shared.sent.length = 0;
  await authority.revoke(grant);
  expect(await authority.needs()).toEqual({ write: false, read: false });
  // The dead read record's projection is dropped once, and this device remembers that it was.
  await vi.waitFor(() => expect(shared.sent).toContain(`delete:${grant}`));
  await authority.needs();
  await authority.needs();
  expect(shared.sent.filter((s) => s === `delete:${grant}`)).toHaveLength(1);
});

test('a read record found dead on another device’s word has its projection dropped without any publishing', async () => {
  const shared = library();
  const { authority } = device(shared, [seed('other'), seed('limited')]);
  const { grant } = await authority.consent('Reader', READ_ONLY);
  // Another device revokes it; this one only reads the rows.
  const other = device(shared, []);
  await other.authority.revoke(grant);
  shared.sent.length = 0;
  const fresh = device(shared, []);
  expect(await fresh.authority.needs()).toEqual({ write: false, read: false });
  await vi.waitFor(() => expect(shared.sent).toEqual([`delete:${grant}`]));
});

test('a quiet library’s publish tick builds nothing until its rows change or something is due', async () => {
  const shared = library();
  let builds = 0;
  const { authority, later } = device(shared, [seed('other'), seed('limited')], {
    random: () => (builds++, randomHex()),
  });
  const { grant } = await authority.consent('Reader', READ_ONLY);
  builds = 0;
  expect(await authority.publish()).toEqual([grant]);
  expect(builds).toBe(1);
  for (let i = 0; i < 10; i++) {
    later(30_000);
    expect(await authority.publish()).toEqual([]);
  }
  expect(builds).toBe(1);
  // The watchlist changes: built at once, sent once it has stood for 30 s.
  shared.documents = [
    {
      format: 4,
      kind: 'title',
      title: { type: 'movie', id: 550 },
      status: { value: 'watchlist', at: [fixed.now, 0, DEVICE] },
      addedAt: fixed.now,
    },
  ];
  later(1_000);
  expect(await authority.publish()).toEqual([]);
  expect(builds).toBe(2);
  later(10_000);
  expect(await authority.publish()).toEqual([]);
  expect(builds).toBe(2);
  later(20_000);
  expect(await authority.publish()).toEqual([grant]);
  expect(builds).toBe(3);
  // And the heartbeat, 15 minutes on.
  later(14 * 60_000);
  expect(await authority.publish()).toEqual([]);
  expect(builds).toBe(3);
  later(60_000);
  expect(await authority.publish()).toEqual([grant]);
  expect(builds).toBe(4);
});

test('a page opened again on the library as it was published builds and sends nothing until its lists change or the heartbeat is due', async () => {
  const shared = library();
  let builds = 0;
  let head = 7;
  let layouts: ReturnType<AssistantPort['layouts']> = {
    '1399': { seasons: [{ season: 1, episodes: 10 }], last_aired: { season: 1, episode: 10 } },
  };
  const { authority, later, reopen } = device(shared, [seed('other'), seed('limited')], {
    random: () => (builds++, randomHex()),
    head: () => head,
    layouts: () => layouts,
  });
  const { grant } = await authority.consent('Reader', READ_ONLY);
  builds = 0;
  expect(await authority.publish()).toEqual([grant]);
  expect(builds).toBe(1);
  // The next page: a new library service, at a head another device's write moved on, which has not learnt the
  // series' layout yet.
  later(60_000);
  head = 9;
  layouts = {};
  expect(await reopen().publish()).toEqual([]);
  expect(builds).toBe(1);
  // The watchlist changes: the page after builds at once, and sends once the change has stood for 30 s and five
  // minutes have passed since the last send.
  shared.documents = [
    {
      format: 4,
      kind: 'title',
      title: { type: 'movie', id: 550 },
      status: { value: 'watchlist', at: [fixed.now, 0, DEVICE] },
      addedAt: fixed.now,
    },
  ];
  const changed = reopen();
  expect(await changed.publish()).toEqual([]);
  expect(builds).toBe(2);
  later(30_000);
  expect(await changed.publish()).toEqual([]);
  expect(builds).toBe(2);
  later(3 * 60_000 + 30_000);
  expect(await changed.publish()).toEqual([grant]);
  // Opened again before the heartbeat: nothing; after it: sent, with a fresh `at`.
  later(10 * 60_000);
  expect(await reopen().publish()).toEqual([]);
  later(5 * 60_000);
  expect(await reopen().publish()).toEqual([grant]);
});

test('a grant’s daily renewal is no change of the projection: the page after builds nothing', async () => {
  const shared = library();
  let builds = 0;
  const { authority, later, reopen } = device(shared, [seed('other'), seed('limited')], {
    random: () => (builds++, randomHex()),
  });
  const { grant } = await authority.consent('Reader', { write: true, read: true });
  builds = 0;
  expect(await authority.publish()).toEqual([grant]);
  expect(builds).toBe(1);
  const before = JSON.stringify(shared.rows.get(READ_ROW));
  later(60_000);
  expect(await authority.renew([grant])).toBeGreaterThan(0);
  expect(JSON.stringify(shared.rows.get(READ_ROW))).not.toBe(before);
  later(60_000);
  expect(await reopen().publish()).toEqual([]);
  expect(builds).toBe(1);
});

test('a change to the household’s hide rules is a change of the projection, sent once it has settled', async () => {
  const shared = library();
  let builds = 0;
  const { authority, later } = device(shared, [seed('other'), seed('limited')], {
    random: () => (builds++, randomHex()),
  });
  const { grant } = await authority.consent('Reader', READ_ONLY);
  expect(await authority.publish()).toEqual([grant]);
  builds = 0;
  shared.patch('prefs', { 'den.hideAnime': { bool: true } });
  later(1_000);
  // Sent a moment ago: nothing is built until a send could follow, five minutes after it.
  expect(await authority.publish()).toEqual([]);
  expect(builds).toBe(0);
  later(5 * 60_000);
  expect(await authority.publish()).toEqual([]);
  expect(builds).toBe(1);
  later(30_000);
  expect(await authority.publish()).toEqual([grant]);
});

/** A film being watched, as a TV saving its progress writes it: Continue Watching carries `fraction` and `at`. */
const watching = (fraction: number, at: number) => ({
  format: 4,
  kind: 'title',
  title: { type: 'movie', id: 680 },
  status: { value: 'inProgress', at: [fixed.now, 0, DEVICE] },
  resume: {
    value: fraction,
    at: [at, 0, DEVICE],
    viewing: 0,
    seconds: Math.round(fraction * 6000),
  },
});

/**
 * den-edge's projection budget (`src/assistant.rs`): 60 an hour per grant, from every device together, in a fixed
 * hour; past it `429` with `Retry-After` to the hour's end.
 */
function projectionBudget(now: () => number) {
  let windowEnd = 0;
  let count = 0;
  const budget = {
    accepted: 0,
    refused: 0,
    put: async (): Promise<true | { retryAfterMs: number }> => {
      if (windowEnd <= now()) [windowEnd, count] = [now() + 60 * 60_000, 0];
      if (count >= 60) return (budget.refused++, { retryAfterMs: windowEnd - now() });
      count++;
      budget.accepted++;
      return true;
    },
  };
  return budget;
}

test('a TV saving progress every minute is sent at most every five minutes by each browser, within den-edge’s budget for two', async () => {
  const shared = library();
  let now = fixed.now;
  const budget = projectionBudget(() => now);
  const browser = () => {
    let builds = 0;
    let puts = 0;
    const made = device(shared, [], {
      now: () => now,
      random: () => (builds++, randomHex()),
      putProjection: async () => (puts++, budget.put()),
    });
    return { ...made, builds: () => builds, puts: () => puts };
  };
  const { grant } = await device(shared, [seed('other'), seed('limited')]).authority.consent(
    'Reader',
    READ_ONLY,
  );
  const phone = browser();
  const mac = browser();
  // Three hours of the TV playing, each browser's page ticking every 30 s (`publishWhileOpen`).
  for (let t = 0; t < 3 * 60 * 60_000; t += 30_000) {
    now = fixed.now + t;
    if (t % 60_000 === 0) shared.documents = [watching(0.1 + t / (4 * 60 * 60_000), now)];
    await phone.authority.publish();
    await mac.authority.publish();
  }
  for (const page of [phone, mac]) {
    // Every five minutes, and the first: 37 in three hours, not one a minute.
    expect(page.puts()).toBeLessThanOrEqual(37);
    // A build is made only when a send could follow it: the change, and again until it has stood 30 s — not every
    // tick (360 in three hours).
    expect(page.builds()).toBeLessThanOrEqual(3 * page.puts());
  }
  expect(budget.refused).toBe(0);
  expect(budget.accepted).toBe(phone.puts() + mac.puts());
  expect(grant).toMatch(/^[0-9a-f]{32}$/);
});

test('a send den-edge refuses waits out its Retry-After, building nothing meanwhile, then goes', async () => {
  const shared = library();
  let builds = 0;
  let refuse = true;
  const attempts: number[] = [];
  const { authority, later } = device(shared, [seed('other'), seed('limited')], {
    random: () => (builds++, randomHex()),
    putProjection: async () => {
      attempts.push(builds);
      return refuse ? { retryAfterMs: 10 * 60_000 } : true;
    },
  });
  const { grant } = await authority.consent('Reader', READ_ONLY);
  builds = 0;
  expect(await authority.publish()).toEqual([]);
  expect(attempts).toHaveLength(1);
  // The library changes all the while; nothing is built or sent until den-edge said it may be.
  for (let t = 30_000; t < 10 * 60_000; t += 30_000) {
    later(30_000);
    shared.documents = [watching(t / (60 * 60_000), fixed.now + t)];
    expect(await authority.publish()).toEqual([]);
  }
  expect(attempts).toHaveLength(1);
  expect(builds).toBe(1);
  refuse = false;
  later(30_000);
  expect(await authority.publish()).toEqual([grant]);
  expect(attempts).toHaveLength(2);
});

test('a grant connected while another is held back is sent at once', async () => {
  const shared = library();
  const { authority, later } = device(shared, [seed('other'), seed('limited'), seed('grant')]);
  const { grant } = await authority.consent('Reader', READ_ONLY);
  expect(await authority.publish()).toEqual([grant]);
  shared.documents = [watching(0.2, fixed.now)];
  later(60_000);
  expect(await authority.publish()).toEqual([]);
  // A second connection: its read record is a change of the read row, which no hold covers.
  const second = await authority.consent('Other', READ_ONLY);
  later(30_000);
  expect(await authority.publish()).toEqual([second.grant]);
});

test('a library with no read records builds no projection at all', async () => {
  const shared = await consented();
  const { authority } = device(shared, []);
  expect(await authority.publish()).toEqual([]);
  expect(shared.sent).toEqual([]);
});

// ---- a household split into profiles (§15, profiles-v1 §4 and §6.1): the connection rows are the household's, the
// lists and the applied row Owner's. The household is the vectors' library; Owner's library is another.

const OWNER_LIBRARY = 'f'.repeat(32);

/** Owner's library and a device of its, and the connection the household's service lends it. */
async function owner(household: Library) {
  const lend = () => device(household, []).authority.lend();
  const shared = library();
  return { shared, lend, ...device(shared, [], { libraryId: OWNER_LIBRARY }) };
}

/** A projection opened as den-mcp opens it (§15 *Sealing in parts*): the compact form's JSON. */
function openProjection(
  readKey: string,
  library: string,
  grant: string,
  sealed: { set: string; parts: string[] },
) {
  const key = Buffer.from(readKey, 'base64url');
  const chunks = sealed.parts.map((part, index) => {
    const bytes = Buffer.from(part, 'base64url');
    const aad = Buffer.from(
      ['den/assistant/projection/v1', library, grant, sealed.set, index, sealed.parts.length].join(
        '\0',
      ),
    );
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(aad);
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
  });
  return JSON.parse(inflateRawSync(Buffer.concat(chunks)).toString('utf8')) as {
    library: string;
    titles: Array<[string, number]>;
    watchlist: Array<[number, number | null]>;
  };
}

test('on a split household Owner applies the household’s queue, and records it in its own applied row', async () => {
  const household = await consented();
  const split = await owner(household);
  const sealed = fixed.request.sealed;
  // Owner's library holds no connection of its own: nothing opens there.
  expect((await split.authority.apply([{ seq: 7, sealed }])).results[0]).toMatchObject({
    outcome: 'rejected',
  });
  expect(split.commands).toEqual([]);

  const lent = await split.lend();
  expect(lent?.member.libraryId).toBe(fixed.library);
  const outcome = await split.authority.apply([{ seq: 8, sealed }], lent);
  expect(outcome.results).toEqual([
    expect.objectContaining({ seq: 8, outcome: 'accepted', op: 'seen' }),
  ]);
  expect(outcome.ack).toBe(8);
  // The household's drop-box key is the one den-edge keeps for its queue.
  expect(outcome.dropbox).toEqual({
    kid: fixed.keys.dropbox!.kid,
    public: fixed.keys.dropbox!.public,
  });
  // Performed on Owner's library, with the applied entry in Owner's row and nothing written to the household.
  expect(split.commands.map((c) => c.command.kind)).toEqual(['episode-watched.set']);
  expect(Object.keys(split.shared.rows.get(APPLIED_ROW)!.values)).toEqual([
    fixed.request.fields.id,
  ]);
  expect(household.rows.get(APPLIED_ROW)).toBeUndefined();
  expect(household.batches).toEqual([]);
  expect((await split.authority.apply([{ seq: 9, sealed }], lent)).results[0]).toMatchObject({
    reason: 'replay',
  });
});

test('on a split household a revocation the household’s device recorded holds on Owner, even against an older row', async () => {
  const household = await consented();
  const split = await owner(household);
  const before = structuredClone(household.rows.get(GRANTS_ROW)!);
  const householdDevice = device(household, []);
  expect(await householdDevice.authority.revoke(GRANT)).toBe('revoked');
  // den-edge serves the grants row from before the revocation: the household's records still carry it to Owner.
  household.rows.set(GRANTS_ROW, before);
  const lent = await householdDevice.authority.lend();
  expect(lent?.revoked).toEqual([GRANT]);
  const outcome = await split.authority.apply([{ seq: 1, sealed: fixed.request.sealed }], lent);
  expect(outcome.results).toEqual([{ seq: 1, outcome: 'rejected', reason: 'revoked' }]);
  expect(split.commands).toEqual([]);
});

test('on a split household Owner publishes its own lists for the household’s read grant, as the household’s member', async () => {
  const household = library();
  const { grant, readKey } = await device(household, [
    seed('other'),
    seed('limited'),
  ]).authority.consent('Reader', READ_ONLY);
  const split = await owner(household);
  split.shared.documents = [
    {
      format: 4,
      kind: 'title',
      title: { type: 'movie', id: 550 },
      status: { value: 'watchlist', at: [fixed.now, 0, DEVICE] },
      addedAt: fixed.now,
    },
  ];
  // Owner's library alone has no read record, so it publishes nothing.
  expect(await split.authority.publish()).toEqual([]);
  expect(split.shared.sent).toEqual([]);

  const lent = await split.lend();
  expect(await split.authority.publish(lent)).toEqual([grant]);
  expect(split.shared.members).toEqual([fixed.library]);
  const view = openProjection(readKey!, fixed.library, grant, split.shared.projections.get(grant)!);
  expect(view.library).toBe(fixed.library);
  expect(view.watchlist.map(([index]) => view.titles[index])).toEqual([['movie', 550]]);

  // A revocation in the household's log is a change of the inputs: the projection is dropped, as its member.
  await device(household, []).authority.revoke(grant);
  split.later(1_000);
  expect(await split.authority.publish(await split.lend())).toEqual([]);
  expect(split.shared.sent.at(-1)).toBe(`delete:${grant}`);
  expect(split.shared.members.at(-1)).toBe(fixed.library);
});
