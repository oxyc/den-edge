import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { react } from './actions';
import { adoptHeldReset, resetLibraryKey, settlePendingReset } from './keyReset';
import { links, readLinks, readPendingReset, writePendingReset } from './links.svelte';
import { LibraryLog, successorTag } from './log';
import { deliverSimkl } from './simklDelivery';
import {
  deriveKeys,
  fromBase64url,
  openEntry,
  openPlaintext,
  rowName,
  seal,
  sealPlaintext,
  type DocumentRow,
  type LibraryKeys,
  type Row,
  type SettingsRow,
  type Stamp,
} from './wire';

const DEVICE = 'aaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbb';
const OLD_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const at = (t: number): Stamp => [t, 0, DEVICE];
const keysOf = (key: string) => deriveKeys(Uint8Array.from(atob(key), (c) => c.charCodeAt(0)));

let storage: Storage;

/** `localStorage` in memory: links, the pending reset and kept work all live there. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
}

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  links.list = [];
  links.shared = [];
  links.add('c'.repeat(16), { name: 'Living room', libraryKey: OLD_KEY, linkKey: 'x' });
});

afterEach(() => vi.unstubAllGlobals());

/**
 * den-edge's `/lib` for several libraries at once, as a key reset uses it: `changes` (404 for a library nobody wrote,
 * 410 for one deleted, naming its successor), compare-and-set `batch` that starts a new library only when it names
 * another one (`NEW_LIBRARIES=members`) and at the minimum it asks for, `member`, and `DELETE`, which refuses a head
 * the library has moved past (`x-den-base`) and retires the id. `legacy` is a den-edge from before `x-den-base` and
 * `x-den-successor`, which ignores both.
 */
function edge({ legacy = false } = {}) {
  interface Library {
    rows: Map<string, { k: string; seq: number; v: string }>;
    head: number;
    generation: string;
    wireMin: number;
    member: string;
  }
  const libraries = new Map<string, Library>();
  /** Each retired id, with the successor its `DELETE` named. */
  const retired = new Map<string, string | undefined>();
  const firstBatches = new Map<string, { member: string | null; wireMin: string | null }>();
  const hooks = {
    /** Runs once, on the first batch that starts a library: another device writing to the old one mid-move. */
    duringMove: null as null | (() => Promise<void>),
    /** Runs once, just before a `DELETE` is applied. */
    beforeDelete: null as null | (() => Promise<void>),
    /** Drops the answer to the next `DELETE`, which still applies. */
    loseDeleteAnswer: false,
    /** Runs once, just after a `DELETE` is applied. */
    afterDelete: null as null | (() => void),
    /** Every request fails, as when den-edge can't be reached. */
    unreachable: false,
    /** The next `DELETE` answers 500 — after retiring the library (`applied`), or before. */
    failDelete: null as null | { applied: boolean },
  };
  const reply = (body: unknown, status = 200, library?: Library) =>
    new Response(JSON.stringify(body), {
      status,
      headers: library
        ? { 'x-den-wire-min': String(library.wireMin), 'x-den-generation': library.generation }
        : {},
    });
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    if (hooks.unreachable) throw new TypeError('Failed to fetch');
    const url = new URL(String(input), 'https://den.example');
    const [, , id = '', action = ''] = url.pathname.split('/');
    const method = init.method ?? 'GET';
    const sent = new Headers(init.headers);
    if (retired.has(id)) {
      const successor = retired.get(id);
      return reply({ error: 'library_moved', ...(successor && !legacy ? { successor } : {}) }, 410);
    }
    const library = libraries.get(id);
    if (library && method !== 'GET' && sent.get('x-den-generation') !== library.generation)
      return reply({ error: 'generation_changed' }, 409, library);
    if (method === 'DELETE' && !action) {
      if (!library) return reply({ error: 'not_found' }, 404);
      if (hooks.beforeDelete) {
        const hook = hooks.beforeDelete;
        hooks.beforeDelete = null;
        await hook();
      }
      const base = sent.get('x-den-base');
      if (!legacy && base !== null && Number(base) !== library.head)
        return reply({ error: 'head_changed' }, 409, library);
      const failing = hooks.failDelete;
      hooks.failDelete = null;
      if (failing && !failing.applied) return reply({ error: 'internal' }, 500, library);
      libraries.delete(id);
      retired.set(id, sent.get('x-den-successor') ?? undefined);
      hooks.afterDelete?.();
      hooks.afterDelete = null;
      if (hooks.loseDeleteAnswer) {
        hooks.loseDeleteAnswer = false;
        throw new TypeError('Failed to fetch');
      }
      if (failing) return reply({ error: 'internal' }, 500);
      return reply({ deleted: true });
    }
    if (action === 'member') return library ? reply({}, 200, library) : reply({}, 404);
    if (action === 'changes') {
      if (!library) return reply({ error: 'not_found', generation: 'g1' }, 404);
      const since = Number(url.searchParams.get('since'));
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 1000), 2);
      const newer = [...library.rows.values()]
        .filter((e) => e.seq > since)
        .sort((a, b) => a.seq - b.seq);
      return reply(
        {
          generation: library.generation,
          entries: newer.slice(0, limit),
          head: library.head,
          more: newer.length > limit,
        },
        200,
        library,
      );
    }
    if (action === 'batch' && method === 'POST') {
      let target = library;
      if (!target) {
        const member = sent.get('x-den-library-member');
        const named = member?.split(':')[0];
        if (!named || libraries.get(named)?.member !== member)
          return reply({ error: 'new_libraries_closed' }, 403);
        firstBatches.set(id, { member, wireMin: sent.get('x-den-wire-min') });
        target = {
          rows: new Map(),
          head: 0,
          generation: `g-${id.slice(0, 4)}`,
          wireMin: Number(sent.get('x-den-wire-min') ?? 2),
          member: '',
        };
        libraries.set(id, target);
        if (hooks.duringMove) {
          const hook = hooks.duringMove;
          hooks.duringMove = null;
          await hook();
        }
      }
      const { writes } = JSON.parse(String(init.body)) as {
        writes: { k: string; base: number; v: string }[];
      };
      const applied: { k: string; seq: number }[] = [];
      const conflicts: { k: string; seq: number; v: string | null }[] = [];
      for (const write of writes) {
        const current = target.rows.get(write.k);
        if ((current?.seq ?? 0) !== write.base) {
          conflicts.push({ k: write.k, seq: current?.seq ?? 0, v: current?.v ?? null });
          continue;
        }
        target.rows.set(write.k, { k: write.k, seq: ++target.head, v: write.v });
        applied.push({ k: write.k, seq: target.head });
      }
      return reply({ head: target.head, applied, conflicts }, 200, target);
    }
    return reply({ error: 'not_found' }, 404);
  };
  return {
    fetchImpl,
    libraries,
    retired,
    firstBatches,
    hooks,
    /** A library at minimum 4 holding `rows`, as another device left it. */
    async seed(key: string, rows: Row[], raw: { k: string; v: string }[] = []) {
      const keys = await keysOf(key);
      const library: Library = {
        rows: new Map(),
        head: 0,
        generation: 'g1',
        wireMin: 4,
        member: `${keys.id}:${keys.member}`,
      };
      for (const entry of [...(await Promise.all(rows.map((row) => seal(keys, row)))), ...raw])
        library.rows.set(entry.k, { ...entry, seq: ++library.head });
      libraries.set(keys.id, library);
      return keys;
    },
    /** Another device's write to the library `keys` open. */
    async append(keys: LibraryKeys, row: Row) {
      const library = libraries.get(keys.id)!;
      const entry = await seal(keys, row);
      library.rows.set(entry.k, { ...entry, seq: ++library.head });
    },
    /** What the library `key` opens holds, each row decoded, by name. */
    async opened(key: string): Promise<Map<string, Row>> {
      const keys = await keysOf(key);
      const out = new Map<string, Row>();
      for (const { k, v } of libraries.get(keys.id)?.rows.values() ?? []) {
        const row = await openEntry(keys, k, v);
        if ('row' in row) out.set(rowName(row.row), row.row);
      }
      return out;
    },
  };
}

const settings = (name: string, values: SettingsRow['values']): SettingsRow => ({
  kind: 'set',
  schema: 2,
  name,
  values,
});

/**
 * A household's v4 library: a film watched twice, a season with its plays, SIMKL connected, settings, a recovery code,
 * and two devices listed.
 */
function household(lease: [string, string]): Row[] {
  const film: DocumentRow = {
    format: 4,
    kind: 'title',
    title: { type: 'movie', id: 550 },
    status: { value: 'watched', at: at(3000) },
    addedAt: 1000,
    watchedAt: 2000,
    watch: { plays: { 0: 2000, 1: 3000 }, cleared: null },
  };
  const season: DocumentRow = {
    format: 4,
    kind: 'season',
    title: { type: 'tv', id: 1399 },
    season: 1,
    seasonReset: null,
    episodes: {
      2: {
        progress: { value: 1, at: at(2500), viewing: 0 },
        imported: false,
        plays: { 0: 2500 },
        cleared: null,
      },
    },
  };
  return [
    film,
    season,
    settings('trackers', {
      'simkl:42': { value: { string: JSON.stringify({ access_token: 'token' }) }, at: at(500) },
    }),
    settings('deliver:simkl:42', {
      since: { value: { string: JSON.stringify(at(500)) }, at: at(500) },
      lease: { value: { strings: lease }, at: at(600) },
    }),
    settings('prefs', { 'den.hideAnime': { value: { bool: true }, at: at(400) } }),
    settings('recovery', {
      '00112233445566778899aabbccddeeff': {
        value: { string: JSON.stringify({ state: 'live', sealed: 'x', createdAt: 1 }) },
        at: at(700),
      },
    }),
    settings('devices', {
      [`${DEVICE}.name`]: { value: { string: 'This browser' }, at: at(800) },
      [`${OTHER}.name`]: { value: { string: 'Living room' }, at: at(800) },
      [`${OTHER}.kind`]: { value: { string: 'tv' }, at: at(800) },
    }),
  ];
}

/** SIMKL with an empty account, counting what it is sent, in front of `server`. */
function simkl(server: ReturnType<typeof edge>) {
  const sent = { count: 0 };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === '/config') return new Response(JSON.stringify({ simklClientId: 'client' }));
    if (url.includes('/sync/all-items'))
      return new Response(JSON.stringify({ movies: [], shows: [] }));
    if (url.includes('api.simkl.com') && init?.method === 'POST') {
      sent.count++;
      return new Response('{}');
    }
    return server.fetchImpl(input, init);
  };
  return { fetchImpl, sent };
}

const destination = (server: ReturnType<typeof edge>) => (key: string) =>
  LibraryLog.destination(key, server.fetchImpl, storage);
const reset = (log: LibraryLog, server: ReturnType<typeof edge>) =>
  resetLibraryKey(log, DEVICE, OLD_KEY, destination(server));
const keyOf = (result: Awaited<ReturnType<typeof reset>>) => (result as { key: string }).key;

/** den-spec's move vectors (library-v4 §12, §15 *Moves*), which the TV's `LibraryMoveVectorTests` replays too. */
const moveVectors = JSON.parse(
  readFileSync(new URL('../../../spec/vectors/library-v4-moves.json', import.meta.url), 'utf8'),
) as {
  device: string;
  from: { libraryKey: string };
  to: { libraryKey: string };
  first_batch: { 'x-den-wire-min': string; 'x-den-library-member': string };
  cases: {
    name: string;
    refused?: string;
    rows: {
      k: string;
      v: string;
      after: { k: string; row?: unknown; plaintext?: string } | null;
    }[];
  }[];
};

describe('den-spec library v4 move vectors', () => {
  for (const vector of moveVectors.cases)
    it(vector.name, async () => {
      const server = edge();
      const from = await server.seed(moveVectors.from.libraryKey, [], vector.rows);
      const log = (await LibraryLog.open(
        moveVectors.from.libraryKey,
        server.fetchImpl,
        undefined,
        null,
      ))!;
      const moving = await log.moving(moveVectors.device);
      if (vector.refused) {
        expect(moving).toEqual({ refused: vector.refused });
        expect(server.libraries.get(from.id)!.rows.size).toBe(vector.rows.length);
        expect(server.libraries.size).toBe(1);
        return;
      }
      if ('refused' in moving) throw new Error(`refused: ${moving.refused}`);
      const next = await LibraryLog.destination(moveVectors.to.libraryKey, server.fetchImpl);
      expect(await next.takeMoved(moving, log.memberProof)).toBe(true);
      const to = await keysOf(moveVectors.to.libraryKey);
      expect(server.firstBatches.get(to.id)).toEqual({
        member: moveVectors.first_batch['x-den-library-member'],
        wireMin: moveVectors.first_batch['x-den-wire-min'],
      });
      const stored = server.libraries.get(to.id)!.rows;
      const expected = vector.rows.flatMap((row) => (row.after ? [row.after] : []));
      expect([...stored.keys()].sort()).toEqual(expected.map((after) => after.k).sort());
      for (const after of expected) {
        const { v } = stored.get(after.k)!;
        if (after.plaintext)
          expect(await openPlaintext(to, after.k, v)).toEqual(fromBase64url(after.plaintext));
        else {
          const opened = await openEntry(to, after.k, v);
          expect('row' in opened && opened.row).toEqual(after.row);
        }
      }
    });
});

describe('resetting the library key (library v4 §12)', () => {
  it('moves every document and receipt, so SIMKL is sent nothing it already has', async () => {
    const server = edge();
    const { fetchImpl, sent } = simkl(server);
    const old = await server.seed(OLD_KEY, household(['', '1']));
    const log = (await LibraryLog.open(OLD_KEY, fetchImpl, undefined, null))!;
    // Delivered once on the old key: the film's watch, list and rating, and the episode.
    expect(await deliverSimkl(log, DEVICE, fetchImpl, 600_000)).toBe(true);
    const delivered = sent.count;
    expect(delivered).toBeGreaterThan(0);
    const before = await server.opened(OLD_KEY);

    const key = keyOf(await reset(log, server));
    const fresh = await keysOf(key);
    expect(server.firstBatches.get(fresh.id)).toEqual({
      member: `${old.id}:${old.member}`,
      wireMin: '4',
    });
    expect(server.retired.get(old.id)).toBe(await successorTag(fresh.id));
    const after = await server.opened(key);
    // Every row, under its new name, as it was — but the recovery code, which wraps the old key, and the other devices.
    expect([...after.keys()].sort()).toEqual(
      [...before.keys()].filter((name) => name !== 'set:recovery').sort(),
    );
    for (const [name, row] of after)
      if (name !== 'set:devices') expect(row).toEqual(before.get(name));
    expect(Object.keys((after.get('set:devices') as SettingsRow).values)).toEqual([
      `${DEVICE}.name`,
    ]);
    expect([...after.keys()].some((name) => name.startsWith('dlv:simkl:42:'))).toBe(true);

    // This browser's links open the new library, and the reset is no longer pending.
    expect(readLinks().map((link) => link.libraryKey)).toEqual([key]);
    expect(readPendingReset()).toBeNull();
    const next = (await LibraryLog.open(key, fetchImpl, undefined, null))!;
    expect(next.wireMinimum).toBe(4);
    expect(next.title({ type: 'movie', id: 550 })?.status.value).toBe('watched');
    expect(await deliverSimkl(next, DEVICE, fetchImpl, 600_000)).toBe(true);
    expect(sent.count).toBe(delivered);
  });

  it('cuts off a device on the old key, even one holding the delivery lease, whose lease is waited out and taken past every carried settle', async () => {
    const server = edge();
    const { fetchImpl, sent } = simkl(server);
    // The other device holds the lease at epoch 7, and settled a receipt at epoch 9.
    const receipts: DocumentRow = {
      format: 4,
      kind: 'delivery',
      provider: 'simkl',
      account: '42',
      title: { type: 'movie', id: 550 },
      entries: { list: ['in', at(1000), [9, 1, OTHER]] },
    };
    await server.seed(OLD_KEY, [...household([OTHER, '7']), receipts]);
    const log = (await LibraryLog.open(OLD_KEY, server.fetchImpl, undefined, null))!;
    // The other device read the library before the reset.
    const other = (await LibraryLog.open(OLD_KEY, server.fetchImpl, undefined, null))!;

    const key = keyOf(await reset(log, server));
    const lease = (await server.opened(key)).get('set:deliver:simkl:42');
    expect((lease as SettingsRow).values.lease?.value).toEqual({ strings: [OTHER, '7'] });

    // Its lease renewal, and anything else it writes, is refused: the library moved.
    expect(await other.writeAt(lease as SettingsRow, 4)).toBe(false);
    expect(other.moved).toBe(true);
    expect((await LibraryLog.open(OLD_KEY, server.fetchImpl, undefined, null))?.moved).toBe(true);

    // On the new key the cut-off holder's lease is waited out: not a minute short of ten.
    const next = (await LibraryLog.open(key, fetchImpl, undefined, null))!;
    expect(await deliverSimkl(next, DEVICE, fetchImpl, 599_999)).toBe(false);
    expect(sent.count).toBe(0);
    expect(await deliverSimkl(next, DEVICE, fetchImpl, 600_000)).toBe(true);
    const taken = (await server.opened(key)).get('set:deliver:simkl:42') as SettingsRow;
    // Above the carried settle's epoch 9, not only the lease's 7.
    expect(taken.values.lease?.value).toEqual({ strings: [DEVICE, '10'] });
  });

  it('refuses while a row only a newer build can rename exists, and leaves the old library as it was', async () => {
    for (const plaintext of [
      // A kind this build doesn't know.
      new TextEncoder().encode('{"kind":"playlist","name":"x"}'),
      // A newer framing.
      new Uint8Array([0x01, 0x02, 0x03]),
    ]) {
      const server = edge();
      const keys = await keysOf(OLD_KEY);
      const stray = await sealPlaintext(keys, 'playlist:x', plaintext);
      await server.seed(OLD_KEY, household(['', '1']), [stray]);
      const log = (await LibraryLog.open(OLD_KEY, server.fetchImpl, undefined, null))!;
      const rows = server.libraries.get(keys.id)!.rows.size;

      expect(await reset(log, server)).toEqual({ refused: 'update_required' });
      expect([...server.libraries.keys()]).toEqual([keys.id]);
      expect(server.libraries.get(keys.id)!.rows.size).toBe(rows);
      expect([...server.retired.keys()].includes(keys.id)).toBe(false);
      expect(readLinks().map((link) => link.libraryKey)).toEqual([OLD_KEY]);
      expect(readPendingReset()).toBeNull();
    }
  });

  it('re-seals a newer-format document with its plaintext unchanged', async () => {
    const server = edge();
    const keys = await keysOf(OLD_KEY);
    const newer = new TextEncoder().encode(
      JSON.stringify({
        format: 5,
        kind: 'title',
        title: { type: 'movie', id: 680 },
        status: { value: 'watchlist', at: at(900) },
        shelf: 'future',
      }),
    );
    await server.seed(OLD_KEY, household(['', '1']), [
      await sealPlaintext(keys, 'title:movie:680', newer),
    ]);
    const log = (await LibraryLog.open(OLD_KEY, server.fetchImpl, undefined, null))!;

    const fresh = await keysOf(keyOf(await reset(log, server)));
    const named = await sealPlaintext(fresh, 'title:movie:680', new Uint8Array());
    const stored = server.libraries.get(fresh.id)!.rows.get(named.k)!;
    expect(await openPlaintext(fresh, stored.k, stored.v)).toEqual(newer);
  });

  const late: DocumentRow = {
    format: 4,
    kind: 'title',
    title: { type: 'movie', id: 777 },
    status: { value: 'watchlist', at: at(5000) },
    addedAt: 5000,
  };

  it('copies again what another device wrote to the old library during the move', async () => {
    const server = edge();
    const old = await server.seed(OLD_KEY, household(['', '1']));
    const log = (await LibraryLog.open(OLD_KEY, server.fetchImpl, undefined, null))!;
    server.hooks.duringMove = () => server.append(old, late);

    const key = keyOf(await reset(log, server));
    expect((await server.opened(key)).get('title:movie:777')).toEqual(late);
    expect(server.retired.has(old.id)).toBe(true);
  });

  it('copies again a write that lands between the last check and the DELETE (x-den-base)', async () => {
    const server = edge();
    const old = await server.seed(OLD_KEY, household(['', '1']));
    const log = (await LibraryLog.open(OLD_KEY, server.fetchImpl, undefined, null))!;
    server.hooks.beforeDelete = () => server.append(old, late);

    const key = keyOf(await reset(log, server));
    expect((await server.opened(key)).get('title:movie:777')).toEqual(late);
  });

  it('on a den-edge without x-den-base or a named successor, still moves the library', async () => {
    const server = edge({ legacy: true });
    const old = await server.seed(OLD_KEY, household(['', '1']));
    const log = (await LibraryLog.open(OLD_KEY, server.fetchImpl, undefined, null))!;

    const key = keyOf(await reset(log, server));
    expect((await server.opened(key)).get('title:movie:550')).toBeDefined();
    expect(server.retired.has(old.id)).toBe(true);
  });

  it("loses a concurrent reset to another device's: deletes its own copy and adopts nothing", async () => {
    const server = edge();
    const old = await server.seed(OLD_KEY, household(['', '1']));
    const log = (await LibraryLog.open(OLD_KEY, server.fetchImpl, undefined, null))!;
    const theirs = 'f'.repeat(32);
    // Another device's reset ends the old library while this one is copying it.
    server.hooks.duringMove = async () => {
      server.libraries.delete(old.id);
      server.retired.set(old.id, theirs);
    };

    expect(await reset(log, server)).toEqual({ refused: 'moved' });
    expect([...server.libraries.keys()]).toEqual([]);
    // Cut off: the link goes, and the link screen says why.
    expect(readLinks()).toEqual([]);
    expect(links.moved).toBe('Living room');
    expect(readPendingReset()).toBeNull();
  });

  it('finishes when the DELETE answer is lost but den-edge names the move as its own', async () => {
    const server = edge();
    const old = await server.seed(OLD_KEY, household(['', '1']));
    const log = (await LibraryLog.open(OLD_KEY, server.fetchImpl, undefined, null))!;
    server.hooks.loseDeleteAnswer = true;

    const key = keyOf(await reset(log, server));
    expect(server.retired.get(old.id)).toBe(await successorTag((await keysOf(key)).id));
    expect(readLinks().map((link) => link.libraryKey)).toEqual([key]);
  });

  it('finishes when the DELETE retired the library and then answered 500', async () => {
    const server = edge();
    const old = await server.seed(OLD_KEY, household(['', '1']));
    const log = (await LibraryLog.open(OLD_KEY, server.fetchImpl, undefined, null))!;
    server.hooks.failDelete = { applied: true };

    const key = keyOf(await reset(log, server));
    expect(server.retired.has(old.id)).toBe(true);
    expect(server.libraries.has((await keysOf(key)).id)).toBe(true);
    expect(readLinks().map((link) => link.libraryKey)).toEqual([key]);
  });

  it('a DELETE that failed with the library still there fences it before deleting the new one', async () => {
    const server = edge();
    const old = await server.seed(OLD_KEY, household(['', '1']));
    const log = (await LibraryLog.open(OLD_KEY, server.fetchImpl, undefined, null))!;
    const head = server.libraries.get(old.id)!.head;
    server.hooks.failDelete = { applied: false };

    expect(await reset(log, server)).toEqual({ refused: 'unavailable' });
    // The head moved on, so a DELETE still on its way is refused (`head_changed`); only then did the new one go.
    expect(server.libraries.get(old.id)!.head).toBeGreaterThan(head);
    expect([...server.libraries.keys()]).toEqual([old.id]);
    expect(readLinks().map((link) => link.libraryKey)).toEqual([OLD_KEY]);
    expect(readPendingReset()).toBeNull();
  });

  it('a 410 naming no successor (a den-edge before tags) is never adopted on its own, and the new key stays readable', async () => {
    const server = edge({ legacy: true });
    const old = await server.seed(OLD_KEY, household(['', '1']));
    const log = (await LibraryLog.open(OLD_KEY, server.fetchImpl, undefined, null))!;
    server.hooks.loseDeleteAnswer = true;

    expect(await reset(log, server)).toEqual({ refused: 'held' });
    expect(server.retired.has(old.id)).toBe(true);
    const pending = readPendingReset()!;
    expect(pending).toMatchObject({ from: OLD_KEY, held: true });
    // The only key to the library is kept, and opens it.
    const kept = (await LibraryLog.open(pending.to, server.fetchImpl, undefined, null))!;
    expect(kept.title({ type: 'movie', id: 550 })?.status.value).toBe('watched');
    expect(readLinks().map((link) => link.libraryKey)).toEqual([OLD_KEY]);

    // A later check still can't prove it: nothing changes on its own, and Reset reports the same.
    expect(await settlePendingReset(destination(server))).toBe('held');
    expect(await reset(log, server)).toEqual({ refused: 'held' });
    expect(readPendingReset()?.to).toBe(pending.to);
    expect(readLinks().map((link) => link.libraryKey)).toEqual([OLD_KEY]);

    // The person says this browser made it: the links move to the kept key.
    expect(await adoptHeldReset(destination(server))).toBe(true);
    expect(readLinks().map((link) => link.libraryKey)).toEqual([pending.to]);
    expect(readPendingReset()).toBeNull();
  });

  it('keeps the new library when whether the DELETE landed is unknown, and pressing Reset again finishes it', async () => {
    const server = edge();
    const old = await server.seed(OLD_KEY, household(['', '1']));
    const log = (await LibraryLog.open(OLD_KEY, server.fetchImpl, undefined, null))!;
    // The answer is lost, and den-edge with it for a while.
    server.hooks.loseDeleteAnswer = true;
    server.hooks.afterDelete = () => void (server.hooks.unreachable = true);

    expect(await reset(log, server)).toEqual({ refused: 'unknown' });
    const pending = readPendingReset()!;
    expect(pending.from).toBe(OLD_KEY);
    expect(server.retired.has(old.id)).toBe(true);
    // The new library holds the whole library; the links still name the old key, and its 410 drops none of them.
    const fresh = await keysOf(pending.to);
    expect(server.libraries.has(fresh.id)).toBe(true);
    links.forgetMoved(links.list[0]!);
    expect(readLinks().map((link) => link.libraryKey)).toEqual([OLD_KEY]);

    // Still unreachable: Settings' check leaves everything as it is.
    expect(await settlePendingReset(destination(server))).toBe('unknown');
    server.hooks.unreachable = false;
    expect(await reset(log, server)).toEqual({ key: pending.to });
    expect(readLinks().map((link) => link.libraryKey)).toEqual([pending.to]);
    expect(readPendingReset()).toBeNull();
  });

  it('undoes a reset cut short before the DELETE: the old library is fenced and stays, the new one goes', async () => {
    const server = edge();
    const old = await server.seed(OLD_KEY, household(['', '1']));
    const head = server.libraries.get(old.id)!.head;
    const to = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));
    const fresh = await keysOf(to);
    // A tab closed mid-copy: the pending reset, and a partial new library.
    writePendingReset({ from: OLD_KEY, to, device: DEVICE });
    server.libraries.set(fresh.id, {
      rows: new Map(),
      head: 0,
      generation: 'gx',
      wireMin: 4,
      member: '',
    });

    expect(await settlePendingReset(destination(server))).toBe('undone');
    expect(server.libraries.has(old.id)).toBe(true);
    expect(server.libraries.get(old.id)!.head).toBeGreaterThan(head);
    expect(server.libraries.has(fresh.id)).toBe(false);
    expect(readLinks().map((link) => link.libraryKey)).toEqual([OLD_KEY]);
    expect(readPendingReset()).toBeNull();
  });

  it("moves this browser's unsent edits to the new key, so they reach the library", async () => {
    const server = edge();
    await server.seed(OLD_KEY, household(['', '1']));
    const log = (await LibraryLog.open(OLD_KEY, server.fetchImpl, storage, null))!;
    // Another tab's edit den-edge refused for now, kept to send later.
    let refusing = false;
    const gated: typeof fetch = async (input, init) =>
      refusing && init?.method === 'POST'
        ? new Response(JSON.stringify({ error: 'rewrite_in_progress' }), { status: 409 })
        : server.fetchImpl(input, init);
    const tab = (await LibraryLog.open(OLD_KEY, gated, storage, null))!;
    refusing = true;
    const film = tab.title({ type: 'movie', id: 550 })!;
    expect(await tab.write(react(film, 'love', at(6000)))).not.toBeNull();
    expect(tab.pendingActions).toBe(1);

    const key = keyOf(await reset(log, server));
    const next = (await LibraryLog.open(key, server.fetchImpl, storage, null))!;
    await next.refresh();
    expect(next.pendingActions).toBe(0);
    const stored = (await server.opened(key)).get('title:movie:550') as DocumentRow;
    expect(stored.reaction).toEqual({ value: 'love', at: at(6000) });
  });

  it('"Use the new key" on a held reset moves the unsent edits to the new key too', async () => {
    const server = edge({ legacy: true });
    await server.seed(OLD_KEY, household(['', '1']));
    const log = (await LibraryLog.open(OLD_KEY, server.fetchImpl, storage, null))!;
    let refusing = false;
    const gated: typeof fetch = async (input, init) =>
      refusing && init?.method === 'POST'
        ? new Response(JSON.stringify({ error: 'rewrite_in_progress' }), { status: 409 })
        : server.fetchImpl(input, init);
    const tab = (await LibraryLog.open(OLD_KEY, gated, storage, null))!;
    refusing = true;
    const film = tab.title({ type: 'movie', id: 550 })!;
    expect(await tab.write(react(film, 'love', at(6000)))).not.toBeNull();
    server.hooks.loseDeleteAnswer = true;

    expect(await reset(log, server)).toEqual({ refused: 'held' });
    const key = readPendingReset()!.to;
    expect(await adoptHeldReset(destination(server))).toBe(true);
    const next = (await LibraryLog.open(key, server.fetchImpl, storage, null))!;
    await next.refresh();
    expect(next.pendingActions).toBe(0);
    const stored = (await server.opened(key)).get('title:movie:550') as DocumentRow;
    expect(stored.reaction).toEqual({ value: 'love', at: at(6000) });
  });
});
