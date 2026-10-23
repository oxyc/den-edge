import { describe, expect, it, vi } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { addToWatchlist, blankEpisode, blankTitle, markWatched, react } from './actions';
import type { Vault } from './localVault';
import {
  applyLog,
  continueWatching,
  untitled,
  watchlist,
  withDisplay,
  type Library,
} from './library';
import { LibraryLog, LibraryUpdateRequiredError } from './log';
import { LibraryFactStore } from './libraryFactStore';
import { applyOps, opsFor } from './libraryV4';
import { forgetLibraryCredential, hasLibraryCredential } from './relayFetch';
import { recordTrackerEvent, trackerEvent } from './trackerEvents';
import { fetchDetailsResult } from './workerTmdbProvider';
import {
  deriveKeys,
  isDocument,
  rowKey,
  rowName,
  seal,
  sealPlaintext,
  type EpisodeRow,
  type Row,
  type SettingsRow,
  type Stamp,
  type TitleRow,
} from './wire';

const LIBRARY_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const at = (t: number, device = 'aaaaaaaaaaaaaaaa'): Stamp => [
  t,
  0,
  /^[0-9a-f]{16}$/.test(device)
    ? device
    : [...device]
        .map((character) => character.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('')
        .padEnd(16, '0')
        .slice(0, 16),
];

const OWNER_ID = '00112233445566778899aabbccddeeff';
const OWNER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(17)));
const profileAt = (t: number): Stamp => [t, 0, 'a1b2c3d4e5f60718'];
const profileDirectory = (name = 'Cindy') => ({
  format: 4 as const,
  kind: 'profiles' as const,
  schema: 1 as const,
  owner: OWNER_ID,
  migration: {
    version: 1 as const,
    attempt: '0123456789abcdef0123456789abcdef',
    source: { generation: 7, head: 'a'.repeat(64) },
    backup: { id: 'backup-7', digest: 'b'.repeat(64) },
    ownerProfile: OWNER_ID,
    ownerHead: 'c'.repeat(64),
  },
  profiles: {
    [OWNER_ID]: {
      id: OWNER_ID,
      role: 'owner' as const,
      display: { value: { name }, at: profileAt(1) },
      library: { value: { keyVersion: 1, key: OWNER_KEY }, at: profileAt(2) },
      policy: {
        value: { maximumAge: null, unknownRatings: 'allow' as const },
        at: profileAt(3),
      },
      deleted: { value: false, at: profileAt(4) },
    },
  },
});

async function sealedProfileDirectory(name = 'Cindy') {
  const keys = await deriveKeys(Uint8Array.from(atob(LIBRARY_KEY), (c) => c.charCodeAt(0)));
  const compressed = deflateRawSync(JSON.stringify(profileDirectory(name)));
  return sealPlaintext(keys, 'profiles', new Uint8Array([0, ...compressed]));
}

async function sealedDirectoryAs(logicalName: string, document: unknown) {
  const keys = await deriveKeys(Uint8Array.from(atob(LIBRARY_KEY), (c) => c.charCodeAt(0)));
  const compressed = deflateRawSync(JSON.stringify(document));
  return sealPlaintext(keys, logicalName, new Uint8Array([0, ...compressed]));
}

function row(id: number, overrides: Partial<TitleRow> = {}): TitleRow {
  return {
    kind: 'rec',
    schema: 2,
    title: { type: 'movie', id },
    status: { value: 'watchlist', at: at(1000) },
    resume: { value: 0, at: at(1000), viewing: 0 },
    reaction: { value: null, at: at(1000) },
    deleted: { value: false, at: at(1000) },
    dismissed: { value: false, at: at(1000) },
    episodesReset: null,
    addedAt: 1000,
    watchedAt: null,
    ...overrides,
  };
}

/** Project test inputs through the v4 write contract before the fake relay stores them. */
function currentRows(rows: Row[]): Row[] {
  const held = new Map<string, Row>();
  for (const row of rows) {
    const event = trackerEvent(row);
    const edits = event
      ? opsFor(event.before, event.after)
      : row.kind === 'rec'
        ? opsFor(
            row.resume.value === 0
              ? { ...blankTitle(row.title, row.addedAt), resume: row.resume }
              : blankTitle(row.title, row.addedAt),
            row,
          )
        : row.kind === 'ep'
          ? opsFor(blankEpisode(row.title, row.season, row.episode), row)
          : [];
    if (edits.length) {
      for (const document of applyOps(edits, (name) => {
        const candidate = held.get(name);
        return candidate && isDocument(candidate) ? candidate : undefined;
      }))
        held.set(rowName(document), document);
    } else held.set(rowName(row), row);
  }
  return [...held.values()];
}

/**
 * den-edge's `/lib` in memory, with library.rs's rules: `changes` paged in sequence order (two a page, so paging
 * is exercised), and `batch` with compare-and-set on each row's sequence.
 */
async function edge(
  rows: Row[] = [],
  extra: { k: string; v: string }[] = [],
  initialGeneration?: string,
) {
  const keys = await deriveKeys(Uint8Array.from(atob(LIBRARY_KEY), (c) => c.charCodeAt(0)));
  let head = 0;
  let generation = initialGeneration;
  const stored = new Map<string, { k: string; seq: number; v: string }>();
  for (const entry of [
    ...(await Promise.all(currentRows(rows).map((r) => seal(keys, r)))),
    ...extra,
  ]) {
    stored.set(entry.k, { ...entry, seq: ++head });
  }
  const fetchImpl: typeof fetch = async (input, init) => {
    if ((init?.headers as Record<string, string>)['x-den-library-token'] !== keys.token) {
      return new Response('{"error":"forbidden"}', { status: 403 });
    }
    if (init?.method === 'POST') {
      const { writes } = JSON.parse(String(init.body)) as {
        writes: { k: string; base: number; v: string }[];
      };
      if (new Set(writes.map((write) => write.k)).size !== writes.length)
        return new Response('{"error":"invalid_batch"}', { status: 400 });
      const applied: { k: string; seq: number }[] = [];
      const conflicts: { k: string; seq: number; v: string | null }[] = [];
      for (const write of writes) {
        const current = stored.get(write.k);
        if ((current?.seq ?? 0) !== write.base) {
          conflicts.push({ k: write.k, seq: current?.seq ?? 0, v: current?.v ?? null });
          continue;
        }
        stored.set(write.k, { k: write.k, seq: ++head, v: write.v });
        applied.push({ k: write.k, seq: head });
      }
      return new Response(JSON.stringify({ head, applied, conflicts }), { status: 200 });
    }
    const since = Number(new URL(String(input), 'https://den.example').searchParams.get('since'));
    const newer = [...stored.values()].filter((e) => e.seq > since).sort((a, b) => a.seq - b.seq);
    return new Response(
      JSON.stringify({ entries: newer.slice(0, 2), head, more: newer.length > 2, generation }),
      { status: 200 },
    );
  };
  const rewrite = (entries: { k: string; v: string }[], nextGeneration = generation) => {
    stored.clear();
    head = 0;
    generation = nextGeneration;
    for (const entry of entries) stored.set(entry.k, { ...entry, seq: ++head });
  };
  const append = async (row: Row) => {
    for (const current of currentRows([row])) {
      const entry = await seal(keys, current);
      stored.set(entry.k, { ...entry, seq: ++head });
    }
  };
  const appendSealed = (entry: { k: string; v: string }) =>
    void stored.set(entry.k, { ...entry, seq: ++head });
  return { fetchImpl, stored, rewrite, append, appendSealed, head: () => head };
}

function memoryVault() {
  const data = new Map<string, Uint8Array>();
  const vault: Vault = {
    get: async (key) => data.get(key),
    entries: async (prefix) => [...data].filter(([key]) => key.startsWith(prefix)),
    put: async (key, value) => void data.set(key, value),
    delete: async (key) => void data.delete(key),
    remove: async (prefix) => {
      for (const key of [...data.keys()]) if (key.startsWith(prefix)) data.delete(key);
    },
    page: async (prefix, after, limit) =>
      [...data]
        .filter(([key]) => key.startsWith(prefix) && (after === undefined || key > after))
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, limit),
    commit: async (changes) => {
      const next = new Map(data);
      for (const change of changes) {
        if (change.kind === 'put') next.set(change.key, change.value.slice());
        else next.delete(change.key);
      }
      data.clear();
      for (const [key, value] of next) data.set(key, value);
    },
  };
  return { data, vault };
}

/** The fact store holds a library: its manifest is kept. */
const keptFacts = (data: Map<string, Uint8Array>) =>
  [...data.keys()].some((key) => key.endsWith(':library-facts.v1:manifest'));

function memoryStorage() {
  const data = new Map<string, string>();
  const storage = {
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  } as Storage;
  return { data, storage };
}

describe('LibraryLog', () => {
  it('promotes explicit full work from individual authority without downloading the library again', async () => {
    const { vault } = memoryVault();
    const keys = await deriveKeys(Uint8Array.from(atob(LIBRARY_KEY), (c) => c.charCodeAt(0)));
    const value = currentRows([row(91)])[0]!;
    const encrypted = await seal(keys, value);
    const facts = (await LibraryFactStore.open(LIBRARY_KEY, vault))!;
    await facts.commitBatch(
      'generation-facts',
      4,
      [{ k: encrypted.k, seq: 4, value: encrypted.v, row: value }],
      true,
    );
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push(
        `${init?.method ?? 'GET'} ${new URL(String(input), 'https://den.test').pathname}`,
      );
      if (init?.method === 'PUT') return new Response(null, { status: 204 });
      throw new Error('the library must not be downloaded');
    };

    const log = (await LibraryLog.open(LIBRARY_KEY, fetchImpl, undefined, vault))!;
    expect(log.title({ type: 'movie', id: 91 })?.status.value).toBe('watchlist');
    // The membership this browser never registered is registered beside the open, not before it.
    await vi.waitFor(() => expect(requests).toEqual([`PUT /lib/${keys.id}/member`]));
  });

  it('reads the validated profile directory beside, never as, profile activity', async () => {
    const server = await edge([], [await sealedProfileDirectory()], 'generation-1');
    const { vault } = memoryVault();
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, vault))!;

    expect(log.rows()).toEqual([]);
    expect(log.documents()).toEqual([]);
    expect(log.profileDirectory()).toMatchObject({
      owner: OWNER_ID,
      profiles: { [OWNER_ID]: { display: { value: { name: 'Cindy' } } } },
    });

    server.appendSealed(await sealedProfileDirectory('Owner'));
    await log.refresh();
    expect(log.profileDirectory()?.profiles[OWNER_ID]?.display.value.name).toBe('Owner');
    await vi.waitFor(async () => {
      const cached = (await LibraryLog.open(
        LIBRARY_KEY,
        async () => Promise.reject(new TypeError('offline')),
        undefined,
        vault,
      ))!;
      expect(cached.fromCache).toBe(true);
      expect(cached.profileDirectory()?.profiles[OWNER_ID]?.display.value.name).toBe('Owner');
    });
  });

  it('fails closed for invalid or misnamed profile directories', async () => {
    const invalid = profileDirectory();
    invalid.profiles[OWNER_ID]!.deleted.value = true;
    const invalidServer = await edge([], [await sealedDirectoryAs('profiles', invalid)]);
    const invalidLog = (await LibraryLog.open(
      LIBRARY_KEY,
      invalidServer.fetchImpl,
      undefined,
      null,
    ))!;
    expect(invalidLog.profileDirectory()).toBeNull();
    expect(invalidLog.unreadable.size).toBe(0);

    const misnamedServer = await edge(
      [],
      [await sealedDirectoryAs('profiles-shadow', profileDirectory())],
    );
    const misnamed = (await LibraryLog.open(
      LIBRARY_KEY,
      misnamedServer.fetchImpl,
      undefined,
      null,
    ))!;
    expect(misnamed.profileDirectory()).toBeNull();
    expect([...misnamed.unreadable.values()]).toContain('identity');
  });

  it('does not treat constructor-valid shape without migration evidence as a committed directory', async () => {
    const { migration: _migration, ...uncommitted } = profileDirectory();
    const server = await edge([], [await sealedDirectoryAs('profiles', uncommitted)]);
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;

    expect(log.profileDirectory()).toBeNull();
    expect(log.unreadable.size).toBe(0);
  });

  it('deactivates a valid and cached directory when a newer profiles row is invalid', async () => {
    const server = await edge([], [await sealedProfileDirectory()], 'generation-1');
    const { vault } = memoryVault();
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, vault))!;
    expect(log.profileDirectory()?.profiles[OWNER_ID]?.display.value.name).toBe('Cindy');

    let online = false;
    const fetchImpl: typeof fetch = (input, init) =>
      online ? server.fetchImpl(input, init) : Promise.reject(new TypeError('offline'));
    const cached = await vi.waitFor(async () => {
      const candidate = (await LibraryLog.open(LIBRARY_KEY, fetchImpl, undefined, vault))!;
      expect(candidate.fromCache).toBe(true);
      expect(candidate.profileDirectory()?.profiles[OWNER_ID]?.display.value.name).toBe('Cindy');
      return candidate;
    });

    const invalid = profileDirectory('Invalid');
    invalid.profiles[OWNER_ID]!.deleted.value = true;
    server.appendSealed(await sealedDirectoryAs('profiles', invalid));
    online = true;
    expect(await cached.refresh()).toBe(true);
    expect(cached.profileDirectory()).toBeNull();
    expect(cached.unreadable.size).toBe(0);

    await vi.waitFor(async () => {
      const reopened = (await LibraryLog.open(
        LIBRARY_KEY,
        async () => Promise.reject(new TypeError('offline')),
        undefined,
        vault,
      ))!;
      expect(reopened.fromCache).toBe(true);
      expect(reopened.profileDirectory()).toBeNull();
    });
  });

  it('forgets directory sequence across a generation reset and accepts a lower replacement', async () => {
    const server = await edge([row(1)], [await sealedProfileDirectory('Before')], 'generation-1');
    const { vault } = memoryVault();
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, vault))!;
    expect(log.profileDirectory()?.profiles[OWNER_ID]?.display.value.name).toBe('Before');

    server.rewrite([await sealedProfileDirectory('After')], 'generation-2');
    expect(await log.refresh()).toBe(true);
    expect(log.profileDirectory()?.profiles[OWNER_ID]?.display.value.name).toBe('After');
  });

  it('deactivates the directory when the replacement generation has none', async () => {
    const server = await edge([], [await sealedProfileDirectory()], 'generation-1');
    const { vault } = memoryVault();
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, vault))!;
    expect(log.profileDirectory()).not.toBeNull();

    server.rewrite([], 'generation-2');
    expect(await log.refresh()).toBe(true);
    expect(log.profileDirectory()).toBeNull();
  });

  it('refuses the single-library key move for a valid, invalid or concurrently appearing directory', async () => {
    const device = '0123456789abcdef';
    // A mock den-edge reports no minimum; a library a move may start from is at the current wire.
    const movable = <T extends LibraryLog>(log: T): T => {
      (log as unknown as { wireMin: number }).wireMin = 4;
      return log;
    };
    const valid = await edge([row(1)], [await sealedProfileDirectory()]);
    const validLog = movable(
      (await LibraryLog.open(LIBRARY_KEY, valid.fetchImpl, undefined, null))!,
    );
    expect(validLog.profileTopologyPresent).toBe(true);
    expect(await validLog.moving(device)).toEqual({ refused: 'profiles' });

    const invalid = profileDirectory();
    invalid.profiles[OWNER_ID]!.deleted.value = true;
    const invalidServer = await edge([row(1)], [await sealedDirectoryAs('profiles', invalid)]);
    const invalidLog = movable(
      (await LibraryLog.open(LIBRARY_KEY, invalidServer.fetchImpl, undefined, null))!,
    );
    expect(invalidLog.profileDirectory()).toBeNull();
    expect(invalidLog.profileTopologyPresent).toBe(true);
    expect(await invalidLog.moving(device)).toEqual({ refused: 'profiles' });

    for (const appeared of [
      await sealedProfileDirectory(),
      await sealedDirectoryAs('profiles', invalid),
    ]) {
      const legacy = await edge();
      const log = movable((await LibraryLog.open(LIBRARY_KEY, legacy.fetchImpl, undefined, null))!);
      expect(log.profileTopologyPresent).toBe(false);
      expect(await log.moving(device)).toMatchObject({ rows: [] });
      legacy.appendSealed(appeared);
      expect(await log.moving(device)).toEqual({ refused: 'profiles' });
    }
  });

  describe('compound key reset primitives', () => {
    const device = '0123456789abcdef';
    const wired = <T extends LibraryLog>(log: T, wireMin: number): T => {
      (log as unknown as { wireMin: number }).wireMin = wireMin;
      return log;
    };
    /** A row a v4 library carries as it is; a v3 row would first need the switch. */
    const preferences = { kind: 'set', schema: 2, name: 'prefs', values: {} } as unknown as Row;

    it('moves a profile household without its directory only when the caller replaces it', async () => {
      const server = await edge([preferences], [await sealedProfileDirectory()]);
      const log = wired(
        (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null, 5))!,
        5,
      );

      expect(await log.moving(device)).toEqual({ refused: 'profiles' });
      const moving = await log.moving(device, { replaceProfileDirectory: true });
      expect(moving).toMatchObject({ rows: [expect.objectContaining({ kind: 'set' })], kept: [] });
      expect('rows' in moving && moving.rows).toHaveLength(1);

      // A household on the profile wire is not "too new" for a build that speaks it, but is for one that does not.
      const narrow = wired(
        (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null, 4))!,
        5,
      );
      expect(await narrow.moving(device, { replaceProfileDirectory: true })).toEqual({
        refused: 'update_required',
      });
    });

    it('still refuses to move a household whose directory is invalid, even when the caller replaces it', async () => {
      const invalid = profileDirectory();
      invalid.profiles[OWNER_ID]!.deleted.value = true;
      const server = await edge([preferences], [await sealedDirectoryAs('profiles', invalid)]);
      const log = wired(
        (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null, 5))!,
        5,
      );
      expect(await log.moving(device, { replaceProfileDirectory: true })).toEqual({
        refused: 'unavailable',
      });
    });

    it('writes a wire-5 successor household at minimum 5, naming the library it moves from', async () => {
      const server = await edge([preferences]);
      const sent: Array<{ path: string; headers: Record<string, string>; body?: unknown }> = [];
      const nextKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
      const next = await LibraryLog.destination(
        nextKey,
        async (input, init) => {
          sent.push({
            path: String(input),
            headers: init?.headers as Record<string, string>,
            body: init?.body && JSON.parse(String(init.body)),
          });
          return new Response(JSON.stringify({ head: 1, applied: [], conflicts: [] }), {
            status: 200,
          });
        },
        undefined,
        null,
        5,
      );
      const from = wired(
        (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null, 5))!,
        5,
      );
      const moving = await from.moving(device);
      if ('refused' in moving) throw new Error('refused');
      await next.takeMoved(moving, from.memberProof);

      expect(sent[0]!.headers['x-den-wire']).toBe('5');
      expect(sent[0]!.headers['x-den-wire-min']).toBe('5');
      expect(sent[0]!.headers['x-den-library-member']).toBe(from.memberProof);
    });

    it('keeps a repeated move of the successor directory idempotent and refuses a different one', async () => {
      const nextKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
      const nextKeys = await deriveKeys(Uint8Array.from(atob(nextKey), (c) => c.charCodeAt(0)));
      const document = new Uint8Array([0, ...deflateRawSync(JSON.stringify(profileDirectory()))]);
      const other = new Uint8Array([
        0,
        ...deflateRawSync(JSON.stringify(profileDirectory('Other'))),
      ]);
      const sealedHere = await sealPlaintext(nextKeys, 'profiles', document);
      const server = {
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              head: 1,
              applied: [],
              conflicts: [{ k: sealedHere.k, seq: 1, v: sealedHere.v }],
            }),
            { status: 200 },
          )) as unknown as typeof fetch,
      };
      const moving = {
        rows: [],
        kept: [{ name: 'profiles', plaintext: document }],
        head: 1,
        generation: null,
        device,
        revokedGrants: [],
      };
      const next = await LibraryLog.destination(nextKey, server.fetchImpl, undefined, null, 5);
      expect(await next.takeMoved(moving, 'member')).toBe(true);
      const different = await LibraryLog.destination(nextKey, server.fetchImpl, undefined, null, 5);
      expect(
        await different.takeMoved(
          { ...moving, kept: [{ name: 'profiles', plaintext: other }] },
          'member',
        ),
      ).toBe(false);
    });

    describe('resetRequest', () => {
      const ATTEMPT = '0123456789abcdef0123456789abcdef';
      const SUCCESSOR = 'c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0';

      async function recorder(reply: (url: string, init: RequestInit) => Response) {
        const keys = await deriveKeys(Uint8Array.from(atob(LIBRARY_KEY), (c) => c.charCodeAt(0)));
        const sent: Array<{ url: string; init: RequestInit }> = [];
        const log = await LibraryLog.destination(
          LIBRARY_KEY,
          async (input, init) => {
            sent.push({ url: String(input), init: init! });
            return reply(String(input), init!);
          },
          undefined,
          null,
          5,
        );
        return { keys, sent, log };
      }

      it('sends exactly the reset routes under the library token and its wire, never in a URL', async () => {
        const { keys, sent, log } = await recorder(
          () => new Response(JSON.stringify({ source: { generation: 3, head: 'a'.repeat(64) } })),
        );
        const reply = await log.resetRequest({
          method: 'GET',
          path: `/lib/${keys.id}/exclusive-operation/source`,
        });

        expect(reply).toEqual({
          status: 200,
          body: { source: { generation: 3, head: 'a'.repeat(64) } },
        });
        const headers = sent[0]!.init.headers as Record<string, string>;
        expect(headers['x-den-library-token']).toBe(keys.token);
        expect(headers['x-den-wire']).toBe('5');
        expect(sent[0]!.url).not.toContain(keys.token);

        await log.resetRequest({
          method: 'POST',
          path: `/lib/${keys.id}/exclusive-operation`,
          body: { attempt: ATTEMPT },
          headers: { 'x-den-successor-token': 'proof' },
        });
        const post = sent[1]!.init.headers as Record<string, string>;
        expect(post['x-den-successor-token']).toBe('proof');
        expect(post['content-type']).toBe('application/json');
        expect(sent[1]!.init.body).toBe(JSON.stringify({ attempt: ATTEMPT }));
      });

      it.each([
        ['an ordinary route', 'POST', (id: string) => `/lib/${id}/batch`, undefined, undefined],
        [
          'another library',
          'GET',
          () => `/lib/${'b'.repeat(32)}/exclusive-operation/source`,
          undefined,
          undefined,
        ],
        [
          'a stray header',
          'GET',
          (id: string) => `/lib/${id}/exclusive-operation/source`,
          undefined,
          { 'x-den-library-token': 'other' },
        ],
        [
          'a body on a read',
          'GET',
          (id: string) => `/lib/${id}/exclusive-operation/source`,
          {},
          undefined,
        ],
        [
          'an acquire with no body',
          'POST',
          (id: string) => `/lib/${id}/exclusive-operation`,
          undefined,
          undefined,
        ],
        [
          'a retirement without its attempt and successor',
          'DELETE',
          (id: string) => `/lib/${id}`,
          undefined,
          undefined,
        ],
      ] as const)('refuses %s', async (_name, method, path, body, headers) => {
        const { keys, sent, log } = await recorder(() => new Response('{}'));
        await expect(
          log.resetRequest({
            method,
            path: path(keys.id),
            ...(body === undefined ? {} : { body }),
            ...(headers === undefined ? {} : { headers }),
          }),
        ).rejects.toThrow('not allowed');
        expect(sent).toEqual([]);
      });

      it('retires with the generation it reads, and does not delete a library that already moved', async () => {
        let moved = false;
        const { keys, sent, log } = await recorder((url) =>
          url.includes('/changes')
            ? moved
              ? new Response('{}', { status: 410 })
              : new Response(
                  JSON.stringify({ entries: [], head: 0, more: false, generation: 'g7' }),
                )
            : new Response(JSON.stringify({ deleted: true })),
        );
        const request = {
          method: 'DELETE' as const,
          path: `/lib/${keys.id}`,
          headers: { 'x-den-exclusive-attempt': ATTEMPT, 'x-den-successor': SUCCESSOR },
        };

        await expect(log.resetRequest(request)).resolves.toEqual({
          status: 200,
          body: { deleted: true },
        });
        const del = sent.at(-1)!.init.headers as Record<string, string>;
        expect(sent.at(-1)!.init.method).toBe('DELETE');
        expect(del['x-den-generation']).toBe('g7');
        expect(del['x-den-exclusive-attempt']).toBe(ATTEMPT);
        expect(del['x-den-successor']).toBe(SUCCESSOR);

        moved = true;
        const before = sent.length;
        await expect(log.resetRequest(request)).resolves.toEqual({
          status: 410,
          body: { error: 'library_moved' },
        });
        expect(sent.slice(before).every(({ init }) => init.method !== 'DELETE')).toBe(true);
      });

      it('passes a refusal through as a status and body, and rejects a success that is not JSON', async () => {
        const refusal = await recorder(
          () => new Response('{"error":"migration_in_progress"}', { status: 409 }),
        );
        await expect(
          refusal.log.resetRequest({
            method: 'GET',
            path: `/lib/${refusal.keys.id}/exclusive-operation/${ATTEMPT}`,
          }),
        ).resolves.toEqual({ status: 409, body: { error: 'migration_in_progress' } });

        const garbled = await recorder(() => new Response('<html>', { status: 200 }));
        await expect(
          garbled.log.resetRequest({
            method: 'GET',
            path: `/lib/${garbled.keys.id}/exclusive-operation/source`,
          }),
        ).rejects.toThrow('not JSON');
      });
    });

    describe('resetSnapshot', () => {
      it('reads every row to the head and opens each, including the directory', async () => {
        const server = await edge([row(1), row(2), row(3)], [await sealedProfileDirectory()]);
        const log = await LibraryLog.destination(LIBRARY_KEY, server.fetchImpl, undefined, null, 5);
        const snapshot = await log.resetSnapshot();
        if (snapshot === null || typeof snapshot === 'string') throw new Error('no snapshot');

        expect(snapshot.base).toBe(4);
        expect(snapshot.rows).toHaveLength(4);
        expect(snapshot.rows.map((r) => r.k)).toEqual([...snapshot.rows.map((r) => r.k)].sort());
        expect(snapshot.names).toHaveLength(3);
        expect(snapshot.directory?.owner).toBe(OWNER_ID);
      });

      it.each([
        [404, 'absent'],
        [410, 'moved'],
        [500, null],
      ] as const)('answers %s as %s', async (status, expected) => {
        const log = await LibraryLog.destination(
          LIBRARY_KEY,
          async () => new Response('{}', { status }),
          undefined,
          null,
          5,
        );
        expect(await log.resetSnapshot()).toBe(expected);
      });

      it('refuses evidence it cannot authenticate', async () => {
        const unreadable = await edge([row(1)], [{ k: 'ab'.repeat(32), v: 'AAAA' }]);
        await expect(
          (
            await LibraryLog.destination(LIBRARY_KEY, unreadable.fetchImpl, undefined, null, 5)
          ).resetSnapshot(),
        ).rejects.toThrow('does not open');

        const invalid = profileDirectory();
        invalid.profiles[OWNER_ID]!.deleted.value = true;
        const bad = await edge([], [await sealedDirectoryAs('profiles', invalid)]);
        await expect(
          (
            await LibraryLog.destination(LIBRARY_KEY, bad.fetchImpl, undefined, null, 5)
          ).resetSnapshot(),
        ).rejects.toThrow('profile directory is invalid');
      });
    });

    it('learns the library minimum from one read, registering nothing and exposing no relay credential', async () => {
      const calls: string[] = [];
      const log = await LibraryLog.forReset(
        LIBRARY_KEY,
        5,
        async (input, init) => {
          calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
          return new Response(JSON.stringify({ entries: [], head: 0, more: false }), {
            status: 200,
            headers: { 'x-den-wire-min': '5' },
          });
        },
        undefined,
        null,
      );
      expect(log.wireMinimum).toBe(5);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatch(/^GET \/lib\/[0-9a-f]{32}\/changes/);
    });
  });

  it('listens for runtime changes in a Worker global without window', async () => {
    const opened: string[] = [];
    class WorkerChannel {
      onmessage: ((event: MessageEvent<{ key?: string; value?: string }>) => void) | null = null;
      constructor(name: string) {
        opened.push(name);
      }
      postMessage() {}
      close() {}
    }
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('BroadcastChannel', WorkerChannel);
    try {
      const server = await edge();
      const { vault } = memoryVault();

      await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, vault);

      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatch(/^den-library-runtime:/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('imports legacy runtime state once, with an existing vault value winning', async () => {
    const { data: legacy, storage } = memoryStorage();
    const { data, vault } = memoryVault();
    const keys = await deriveKeys(Uint8Array.from(atob(LIBRARY_KEY), (c) => c.charCodeAt(0)));
    const runtime = `${keys.id}:runtime:`;
    const pending = JSON.stringify({ k: 'ab', v: 'AAAA' });
    legacy.set(`den.pendingTracker.${keys.id}.old`, pending);
    legacy.set(`den.libraryObservedGeneration.${keys.id}`, 'legacy-generation');
    legacy.set(`den.libraryWireMin.${keys.id}`, '3');
    legacy.set(`den.libraryCompacted.${keys.id}`, JSON.stringify(['old-row']));
    data.set(`${runtime}meta:observed`, new TextEncoder().encode('vault-generation'));
    data.set(`${runtime}meta:wireMin`, new TextEncoder().encode('2'));
    data.set(`${runtime}meta:compacted`, new TextEncoder().encode(JSON.stringify(['vault-row'])));
    const server = await edge([row(1)]);

    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, storage, vault))!;

    expect(log.observedGeneration).toBe('vault-generation');
    expect(log.wireMinimum).toBeGreaterThanOrEqual(3);
    expect(log.pendingActions).toBe(1);
    expect([...legacy.keys()].filter((key) => key.includes(keys.id))).toEqual([]);
    expect(new TextDecoder().decode(data.get(`${runtime}pending:old`))).toBe(pending);
    expect(JSON.parse(new TextDecoder().decode(data.get(`${runtime}meta:compacted`)))).toEqual([
      'vault-row',
      'old-row',
    ]);

    const reopened = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, storage, vault))!;
    expect(reopened.observedGeneration).toBe('vault-generation');
    expect(reopened.pendingActions).toBe(1);
  });

  it('fails a durable edit before the request when the vault refuses its pending record', async () => {
    const memory = memoryVault();
    const vault: Vault = {
      ...memory.vault,
      put: async (key, value) => {
        if (key.includes(':runtime:pending:'))
          throw new DOMException('quota', 'QuotaExceededError');
        await memory.vault.put(key, value);
      },
    };
    const server = await edge();
    let writes = 0;
    const connection: typeof fetch = async (input, init) => {
      if (init?.method === 'POST') writes++;
      return server.fetchImpl(input, init);
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, vault))!;
    const before = blankTitle({ type: 'movie', id: 10 }, 0);

    expect(await log.write(addToWatchlist(before, at(1000)))).toBeNull();
    expect(writes).toBe(0);
    expect(log.pendingActions).toBe(0);
  });

  it('rekeys vault pending work without leaving the old copy behind', async () => {
    const { vault } = memoryVault();
    const server = await edge();
    let refuse = true;
    const connection: typeof fetch = async (input, init) => {
      if (refuse && init?.method === 'POST') {
        refuse = false;
        return new Response(JSON.stringify({ error: 'rewrite_in_progress' }), { status: 409 });
      }
      return server.fetchImpl(input, init);
    };
    const from = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, vault))!;
    const before = blankTitle({ type: 'movie', id: 10 }, 0);
    expect(await from.write(addToWatchlist(before, at(1000)))).not.toBeNull();
    const nextKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
    const to = await LibraryLog.destination(nextKey, server.fetchImpl, undefined, vault);

    await from.rekeyKept(to);

    expect(from.pendingActions).toBe(0);
    expect(to.pendingActions).toBe(1);
  });

  it('keeps an acknowledged write before it returns so an immediate reload cannot restore stale data', async () => {
    const server = await edge([row(1)], [], 'generation-1');
    const { storage } = memoryStorage();
    const { vault } = memoryVault();
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, storage, vault))!;

    await log.write(row(2));

    const offline: typeof fetch = async () => {
      throw new TypeError('offline');
    };
    const reopened = (await LibraryLog.open(LIBRARY_KEY, offline, storage, vault))!;
    expect(reopened.fromCache).toBe(true);
    expect(reopened.title({ type: 'movie', id: 2 })).toBeDefined();
  });

  it('advertises wire 4 and the generation on every library request', async () => {
    const server = await edge([row(1)]);
    const requests: RequestInit[] = [];
    const recording: typeof fetch = async (input, init = {}) => {
      requests.push(init);
      return server.fetchImpl(input, init);
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, recording, undefined, null))!;
    await log.write(row(2));
    await log.forget();
    expect(requests.length).toBeGreaterThan(2);
    for (const request of requests) {
      expect(request.headers).toMatchObject({ 'x-den-wire': '4', 'x-den-generation': '0' });
    }
  });

  it('remembers the highest wire minimum and exposes a future upgrade fence', async () => {
    const server = await edge([row(1)]);
    const { storage } = memoryStorage();
    const future: typeof fetch = async (input, init) => {
      const response = await server.fetchImpl(input, init);
      const headers = new Headers(response.headers);
      headers.set('x-den-wire-min', '5');
      return new Response(response.body, { status: response.status, headers });
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, future, storage, null))!;
    expect(log.wireMinimum).toBe(5);
    expect(log.upgradeRequired).toBe(5);
    expect(log.readOnly).toBe(true);
    expect(await log.write(row(2))).toBeNull();
    const reopened = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, storage, null))!;
    expect(reopened.wireMinimum).toBe(5);
  });

  it('distinguishes den-edge’s 426 wire fence from an unreachable library', async () => {
    const requests: RequestInit[] = [];
    const future: typeof fetch = async (_input, init = {}) => {
      requests.push(init);
      return new Response(JSON.stringify({ error: 'upgrade_required' }), {
        status: 426,
        headers: { 'content-type': 'application/json', 'x-den-wire-min': '5' },
      });
    };

    await expect(LibraryLog.open(LIBRARY_KEY, future, undefined, null)).rejects.toEqual(
      expect.objectContaining<Partial<LibraryUpdateRequiredError>>({
        name: 'LibraryUpdateRequiredError',
        requiredWire: 5,
      }),
    );
    // The membership is registered only after a first page names the generation, so the read is all that was sent.
    expect(requests.length).toBeGreaterThanOrEqual(1);
    for (const request of requests) expect(request.headers).toMatchObject({ 'x-den-wire': '4' });
  });

  it('opens a configuration-only household with wire 5 while retaining v4 rows', async () => {
    const server = await edge([row(1)]);
    const requests: RequestInit[] = [];
    const household: typeof fetch = async (input, init = {}) => {
      requests.push(init);
      const response = await server.fetchImpl(input, init);
      const headers = new Headers(response.headers);
      headers.set('x-den-wire-min', '5');
      return new Response(response.body, { status: response.status, headers });
    };

    const log = (await LibraryLog.open(LIBRARY_KEY, household, undefined, null, 5))!;
    expect(log.wireMinimum).toBe(5);
    expect(log.upgradeRequired).toBeNull();
    expect(log.readOnly).toBe(false);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request.headers).toMatchObject({ 'x-den-wire': '5' });
  });

  it('keeps a settings-style row across a generation or rewrite refusal', async () => {
    const server = await edge([row(1)]);
    const { storage } = memoryStorage();
    let refusal: 'generation_changed' | 'rewrite_in_progress' | null = 'generation_changed';
    const connection: typeof fetch = async (input, init) => {
      if (init?.method === 'POST' && refusal) {
        const code = refusal;
        refusal = null;
        return new Response(JSON.stringify({ error: code }), { status: 409 });
      }
      return server.fetchImpl(input, init);
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, storage, null))!;
    expect(await log.write(row(2)), 'durable locally').not.toBeNull();
    expect(log.pendingActions).toBe(1);
    await log.refresh();
    expect(log.pendingActions).toBe(0);
    expect(log.title({ type: 'movie', id: 2 })).toBeDefined();
  });

  it('adopts the server generation and retries the refused write immediately', async () => {
    const server = await edge([row(1)]);
    const writeGenerations: string[] = [];
    let changed = false;
    const connection: typeof fetch = async (input, init = {}) => {
      const headers = init.headers as Record<string, string>;
      if (init.method === 'POST') {
        writeGenerations.push(headers['x-den-generation'] ?? 'missing');
        if (!changed) {
          changed = true;
          return new Response(JSON.stringify({ error: 'generation_changed' }), {
            status: 409,
            headers: { 'x-den-generation': 'new' },
          });
        }
      }
      const response = await server.fetchImpl(input, init);
      if (init.method) return response;
      const body = (await response.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, generation: 'old' }), {
        status: response.status,
        headers: { 'x-den-generation': 'old' },
      });
    };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, null))!;

    expect(await log.write(row(2))).not.toBeNull();
    expect(writeGenerations).toEqual(['old', 'new']);
    expect(log.title({ type: 'movie', id: 2 })).toBeDefined();
    expect(warning).toHaveBeenCalledWith(
      'den: library generation changed during a write; retrying with new',
    );
    warning.mockRestore();
  });

  it('survives its own default fetch being called as a method', async () => {
    const server = await edge([row(1)]);
    const strict = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return server.fetchImpl(input, init);
    };
    vi.stubGlobal('fetch', strict);
    try {
      const log = (await LibraryLog.open(LIBRARY_KEY, undefined, undefined, null))!;
      expect(await log.write(row(2))).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('starts a return visit from the kept copy and asks only for what changed since', async () => {
    const { data, vault } = memoryVault();
    const server = await edge([row(1), row(2), row(3)], [], 'generation-1');
    const asked: string[] = [];
    const counting: typeof fetch = (input, init) => {
      asked.push(String(input));
      return server.fetchImpl(input, init);
    };
    await LibraryLog.open(LIBRARY_KEY, counting, undefined, vault);
    await vi.waitFor(() => expect(keptFacts(data)).toBe(true));
    for (const value of data.values())
      expect(new TextDecoder().decode(value)).not.toContain('watchlist');

    // Meanwhile the TV adds a title and changes another.
    const tv = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    await tv.write(addToWatchlist(blankTitle({ type: 'movie', id: 4 }, 1_000), at(1_000)));
    await tv.write(markWatched(tv.title({ type: 'movie', id: 1 })!, at(2_000)));

    asked.length = 0;
    const log = (await LibraryLog.open(LIBRARY_KEY, counting, undefined, vault))!;
    expect(asked).toEqual([]);
    expect(log.fromCache).toBe(true);
    expect(log.rows()).toHaveLength(3);
    expect(await log.refresh()).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('since=3');
    expect(log.title({ type: 'movie', id: 4 })?.status.value).toBe('watchlist');
    expect(log.title({ type: 'movie', id: 1 })?.status.value).toBe('watched');

    // The refresh is kept too: the next visit already knows both.
    await vi.waitFor(async () => {
      const next = (await LibraryLog.open(LIBRARY_KEY, counting, undefined, vault))!;
      expect(next.title({ type: 'movie', id: 1 })?.status.value).toBe('watched');
    });
  });

  it('resolves profile discovery after an unchanged return-visit refresh', async () => {
    const { data, vault } = memoryVault();
    const server = await edge([row(1)], [], 'generation-1');
    const household: typeof fetch = async (input, init) => {
      const response = await server.fetchImpl(input, init);
      const headers = new Headers(response.headers);
      headers.set('x-den-wire-min', '5');
      return new Response(response.body, { status: response.status, headers });
    };
    const first = (await LibraryLog.open(LIBRARY_KEY, household, undefined, vault, 5))!;
    expect(first.profileDirectoryPending).toBe(false);
    await vi.waitFor(() => expect(keptFacts(data)).toBe(true));

    const returned = (await LibraryLog.open(LIBRARY_KEY, household, undefined, vault, 5))!;
    expect(returned.fromCache).toBe(true);
    expect(returned.profileDirectoryPending).toBe(true);

    expect(await returned.refresh()).toBe(true);
    expect(returned.profileDirectoryPending).toBe(false);
  });

  it('keeps an edit as the one document it changed, never the whole library again', async () => {
    const { data, vault } = memoryVault();
    const server = await edge([row(1), row(3), row(4)], [], 'generation-1');
    const written: string[] = [];
    const recording: Vault = {
      ...vault,
      put: async (key, value) => (written.push(key), vault.put(key, value)),
      commit: async (changes) => {
        written.push(...changes.map((change) => change.key));
        await vault.commit!(changes);
      },
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, recording))!;
    written.length = 0;
    await log.write(addToWatchlist(blankTitle({ type: 'movie', id: 2 }, 1_000), at(1_000)));
    await vi.waitFor(() =>
      expect(written.some((key) => key.includes(':library-facts.v1:'))).toBe(true),
    );

    const keys = await deriveKeys(Uint8Array.from(atob(LIBRARY_KEY), (c) => c.charCodeAt(0)));
    const changed = await rowKey(keys, 'title:movie:2');
    const library = written.filter((key) => !key.includes(':runtime:'));
    expect(library.filter((key) => key.includes(':library-facts.v1:'))).not.toEqual([]);
    // The changed document, the finished-view marker, and the store's manifest, which takes its newest stamp in.
    for (const key of library)
      expect(
        key.endsWith(':local-authority.v1') ||
          key.endsWith(':library-facts.v1:manifest') ||
          key.endsWith(changed),
        key,
      ).toBe(true);
    expect([...data.keys()].filter((key) => /:log\.v[14]$/.test(key))).toEqual([]);
    log.close();

    const offline: typeof fetch = async () => Promise.reject(new TypeError('offline'));
    const reopened = (await LibraryLog.open(LIBRARY_KEY, offline, undefined, vault))!;
    expect(reopened.title({ type: 'movie', id: 2 })).toBeDefined();
    expect(reopened.rows()).toHaveLength(4);
  });

  it('keeps acknowledged bulk documents before a local-library merge can navigate away', async () => {
    const { vault } = memoryVault();
    const server = await edge([row(1)], [], 'generation-1');
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, vault))!;
    const imported = currentRows([row(2)])[0]!;

    expect(await log.writeRows([imported])).toBe(true);

    const reopened = (await LibraryLog.open(
      LIBRARY_KEY,
      async () => Promise.reject(new TypeError('offline')),
      undefined,
      vault,
    ))!;
    expect(reopened.fromCache).toBe(true);
    expect(reopened.title({ type: 'movie', id: 2 })?.status.value).toBe('watchlist');
  });

  /** A library an earlier build kept whole, under the name `persist` wrote it to before the fact store kept it. */
  async function keptWhole(snapshot: (log: LibraryLog) => unknown, generation = 'generation-1') {
    const { data, vault } = memoryVault();
    const server = await edge([row(1), row(2)], [], generation);
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, vault))!;
    await log.keep('log.v1', snapshot(log));
    for (const key of [...data.keys()]) if (key.includes(':library-facts.v1:')) data.delete(key);
    log.close();
    return { data, vault, server };
  }

  it('moves a library an earlier build kept whole into the fact store once, then opens from that', async () => {
    const { data, vault } = await keptWhole((log) => ({
      generation: 'generation-1',
      head: 2,
      entries: log.documents().map(({ seq, document }) => [rowName(document), seq, document]),
    }));
    const offline: typeof fetch = async () => Promise.reject(new TypeError('offline'));

    const moved = (await LibraryLog.open(LIBRARY_KEY, offline, undefined, vault))!;
    expect(moved.fromCache).toBe(true);
    expect(moved.rows()).toHaveLength(2);
    expect(
      [...data.keys()].filter((key) => key.endsWith(':log.v1')),
      'the whole copy',
    ).toEqual([]);
    expect(keptFacts(data)).toBe(true);

    const again = (await LibraryLog.open(LIBRARY_KEY, offline, undefined, vault))!;
    expect(again.fromCache).toBe(true);
    expect(again.rows()).toHaveLength(2);
  });

  it('reads den-edge again for a library kept whole with its profile directory, which the store cannot take', async () => {
    const { data, vault, server } = await keptWhole((log) => ({
      generation: 'generation-1',
      head: 2,
      entries: log.rows().map((held) => [rowName(held), 1, held]),
      profileDirectory: [3, profileDirectory()],
    }));
    const offline: typeof fetch = async () => Promise.reject(new TypeError('offline'));

    expect(await LibraryLog.open(LIBRARY_KEY, offline, undefined, vault)).toBeNull();
    expect([...data.keys()].filter((key) => key.endsWith(':log.v1'))).toEqual([]);
    const read = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, vault))!;
    expect(read.fromCache).toBe(false);
    expect(read.rows()).toHaveLength(2);
  });

  it('leaves a library kept only here (no generation) as it is when its key is opened on den-edge', async () => {
    const { data, vault } = await keptWhole((log) => ({
      head: 0,
      entries: log.rows().map((held) => [rowName(held), 0, held]),
    }));
    const offline: typeof fetch = async () => Promise.reject(new TypeError('offline'));

    await LibraryLog.open(LIBRARY_KEY, offline, undefined, vault);
    expect([...data.keys()].filter((key) => key.endsWith(':log.v1'))).toHaveLength(1);
  });

  it('keeps its own write for the next visit once den-edge has echoed it', async () => {
    const { vault } = memoryVault();
    const server = await edge([row(1)]);
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, vault))!;
    await log.write(row(2));
    await log.refresh();
    await vi.waitFor(async () => {
      const next = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, vault))!;
      expect(next.title({ type: 'movie', id: 2 })).toBeDefined();
    });
  });

  /**
   * A refresh that reads back only this browser's own writes changes no row. The head it read to was kept only with
   * a changed row, so a library this browser had written (a household's move writes its whole history) was read from
   * den-edge and opened row by row again on every visit.
   */
  it('keeps the head it read its own writes back to, so the next visit does not read them again', async () => {
    const { vault } = memoryVault();
    const server = await edge([row(1)], [], 'generation-1');
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, vault))!;
    await log.write(row(2));
    await log.write(row(3));
    expect(await log.refresh(), 'its own writes read back').toBe(false);
    const asked: string[] = [];
    const counting: typeof fetch = (input, init) => {
      asked.push(String(input));
      return server.fetchImpl(input, init);
    };
    await vi.waitFor(async () => {
      asked.length = 0;
      const next = (await LibraryLog.open(LIBRARY_KEY, counting, undefined, vault))!;
      expect(next.fromCache).toBe(true);
      await next.refresh();
      expect(asked[0]).toContain('since=3');
    });
  });

  /**
   * `LibrarySession` bumps its revision on a refresh that returns true, and every page built from the library is
   * rebuilt on that. A 30-second poll that found nothing returned true, and rebuilt them all every 30 seconds.
   */
  it('says a refresh changed something only when a row arrived', async () => {
    const server = await edge([row(1)]);
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl))!;
    expect(await log.refresh(), 'an empty page').toBe(false);
    await log.write(row(2));
    expect(await log.refresh(), 'its own write read back').toBe(false);
    const tv = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl))!;
    await tv.write(row(3));
    expect(await log.refresh(), "the TV's write").toBe(true);
    expect(log.title({ type: 'movie', id: 3 })).toBeDefined();
    expect(await log.refresh()).toBe(false);
  });

  it('asks den-edge to hold an active-playback refresh without changing ordinary refreshes', async () => {
    const server = await edge([row(1)]);
    const asked: string[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      asked.push(String(input));
      return server.fetchImpl(input, init);
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, fetchImpl))!;
    asked.length = 0;

    await log.refresh();
    await log.refresh(5);

    expect(asked[0]).not.toContain('wait=');
    expect(asked[1]).toContain('&wait=5');
  });

  /**
   * A refresh that read one page and failed on the next keeps the rows of the first, and said nothing: the next one,
   * finding only this browser's own write, said nothing either, and the TV's rows were never drawn.
   */
  it('says a change a failed refresh read, on the next refresh that finishes', async () => {
    const server = await edge([row(1)]);
    let reads = 0;
    let failSecondRead = false;
    const connection: typeof fetch = async (url, init) => {
      if (!init?.method && failSecondRead && ++reads === 2) throw new TypeError('offline');
      return server.fetchImpl(url, init);
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, connection))!;
    const tv = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl))!;
    await tv.write(row(2));
    await tv.write(row(3));
    await log.write(row(4));
    failSecondRead = true;
    expect(await log.refresh(), 'failed on its second page').toBe(false);
    expect(await log.refresh(), "the TV's rows it read before").toBe(true);
    expect(log.title({ type: 'movie', id: 2 })).toBeDefined();
    expect(await log.refresh()).toBe(false);
  });

  /** Refresh and writes share one queue: a read den-edge never answered held every later save behind it. */
  it('gives up on a request den-edge never answers, and saves after it', async () => {
    const server = await edge([row(1)]);
    let stall = false;
    const connection: typeof fetch = (url, init) =>
      stall && init?.method !== 'POST'
        ? new Promise((_, reject) =>
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
          )
        : server.fetchImpl(url, init);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection))!;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      stall = true;
      const refreshed = log.refresh();
      const saved = log.write(row(2));
      await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await refreshed).toBe(false);
      expect(await saved).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The same limit covered the whole body: a large page of `/changes` on a slow link, arriving all along, was cut off
   * at 20 seconds every time. It now limits only the wait for den-edge to start answering, and each stall after.
   */
  it('reads an answer that keeps arriving for longer than a request may wait, and gives up on one that stops', async () => {
    const server = await edge([row(1)]);
    let slow = false;
    let stopAfter = Infinity;
    // Each piece of the answer 10 s after the last, and none after `stopAfter` pieces.
    const connection: typeof fetch = async (url, init) => {
      const res = await server.fetchImpl(url, init);
      if (!slow || init?.method) return res;
      const text = await res.text();
      const pieces = [text.slice(0, 10), text.slice(10, 20), text.slice(20)];
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull: (stream) =>
          new Promise<void>((resolve, reject) => {
            if (sent >= stopAfter) return;
            const next = setTimeout(() => {
              const piece = pieces[sent++];
              if (piece === undefined) stream.close();
              else stream.enqueue(new TextEncoder().encode(piece));
              resolve();
            }, 10_000);
            init?.signal?.addEventListener('abort', () => {
              clearTimeout(next);
              reject(init.signal!.reason);
            });
          }),
      });
      return new Response(body, { status: res.status });
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, connection))!;
    const tv = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl))!;
    await tv.write(row(2));
    // A limit on the whole request, as before, on the same clock as the answer.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      slow = true;
      const refreshed = log.refresh();
      await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(50_000);
      expect(await refreshed, 'arrived over 40 s').toBe(true);
      expect(log.title({ type: 'movie', id: 2 })).toBeDefined();

      await tv.write(row(3));
      stopAfter = 1;
      const stalled = log.refresh();
      await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(40_000);
      expect(await stalled, 'stopped after its first piece').toBe(false);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  /** A first read cut off part way started again from the first page on every visit, and on a slow link never ended. */
  it('goes on with a first read from the last page it kept', async () => {
    const { data, vault } = memoryVault();
    const server = await edge([row(1), row(2), row(3), row(4), row(5)], [], 'generation-1');
    const asked: string[] = [];
    let failAt = 2;
    const connection: typeof fetch = async (url, init) => {
      if (!init?.method) {
        asked.push(String(url));
        if (asked.length === failAt) throw new TypeError('offline');
      }
      return server.fetchImpl(url, init);
    };
    const partial = () => [...data.keys()].some((key) => key.endsWith(':log-partial.v1'));
    expect(await LibraryLog.open(LIBRARY_KEY, connection, undefined, vault)).toBeNull();
    await vi.waitFor(() => expect(partial()).toBe(true));
    asked.length = 0;
    failAt = 0;
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, vault))!;
    expect(log.fromCache).toBe(false);
    expect(asked[0]).toContain('since=2');
    expect(log.rows()).toHaveLength(5);
    await vi.waitFor(async () => {
      expect(partial(), 'the pages read so far are forgotten').toBe(false);
      const next = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, vault))!;
      expect(next.fromCache).toBe(true);
      expect(next.rows()).toHaveLength(5);
    });
  });

  it('commits each cold-import page before requesting the next one', async () => {
    const stored = memoryVault();
    const server = await edge([row(1), row(2), row(3)]);
    let release!: () => void;
    const checkpointMayFinish = new Promise<void>((resolve) => (release = resolve));
    let checkpointStarted = false;
    const vault: Vault = {
      ...stored.vault,
      put: async (key, value) => {
        if (key.endsWith(':log-partial.v1')) {
          checkpointStarted = true;
          await checkpointMayFinish;
        }
        await stored.vault.put(key, value);
      },
    };
    let pages = 0;
    const connection: typeof fetch = (input, init) => {
      if (!init?.method) pages++;
      return server.fetchImpl(input, init);
    };

    const opening = LibraryLog.open(LIBRARY_KEY, connection, undefined, vault);
    await vi.waitFor(() => expect(checkpointStarted).toBe(true));
    expect(pages, 'the next page waits for the checkpoint transaction').toBe(1);
    release();
    await expect(opening).resolves.not.toBeNull();
    expect(pages).toBe(2);
  });

  it('stops a cold import when its page checkpoint cannot be committed', async () => {
    const stored = memoryVault();
    const server = await edge([row(1), row(2), row(3)]);
    const vault: Vault = {
      ...stored.vault,
      put: async (key, value) => {
        if (key.endsWith(':log-partial.v1')) throw new Error('storage full');
        await stored.vault.put(key, value);
      },
    };
    let pages = 0;
    const connection: typeof fetch = (input, init) => {
      if (!init?.method) pages++;
      return server.fetchImpl(input, init);
    };

    await expect(LibraryLog.open(LIBRARY_KEY, connection, undefined, vault)).resolves.toBeNull();
    expect(pages, 'an uncommitted page must not be followed by another page').toBe(1);
  });

  it('registers a membership not yet registered as soon as a return visit opens', async () => {
    const { data, vault } = memoryVault();
    const server = await edge([row(1)], [], 'generation-1');
    let members = 0;
    let refuseMember = true;
    const connection: typeof fetch = async (url, init) => {
      if (init?.method === 'PUT') {
        members++;
        if (refuseMember) return new Response('{}', { status: 503 });
        return new Response('{}');
      }
      return server.fetchImpl(url, init);
    };
    forgetLibraryCredential();
    await LibraryLog.open(LIBRARY_KEY, connection, undefined, vault);
    await vi.waitFor(() => expect(keptFacts(data)).toBe(true));
    forgetLibraryCredential();
    refuseMember = false;
    members = 0;
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, vault))!;
    expect(log.fromCache).toBe(true);
    await vi.waitFor(() => expect(hasLibraryCredential()).toBe(true));
    expect(members).toBe(1);
    await log.refresh();
    expect(members, 'not asked again').toBe(1);
    forgetLibraryCredential();
  });

  it('a copy kept for another library key opens nothing, and the log is read whole', async () => {
    const { data, vault } = memoryVault();
    const server = await edge([row(1)], [], 'generation-1');
    await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, vault);
    await vi.waitFor(() => expect(keptFacts(data)).toBe(true));
    const [key, value] = [...data].find(([name]) => name.endsWith(':library-facts.v1:manifest'))!;
    const tampered = value.slice();
    tampered[20] = tampered[20]! ^ 1;
    data.set(key, tampered);
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, vault))!;
    expect(log.fromCache).toBe(false);
    expect(log.title({ type: 'movie', id: 1 })).toBeDefined();
  });

  it('reads to the head only when den-edge answered, and not across a generation change', async () => {
    const server = await edge([row(1), row(2), row(3)]);
    let busy = false;
    let generation = 'original';
    const connection: typeof fetch = async (url, init) => {
      if (busy && init?.method !== 'POST')
        return new Response('{"error":"server_busy"}', { status: 503 });
      const res = await server.fetchImpl(url, init);
      return new Response(JSON.stringify({ ...(await res.json()), generation }), {
        status: res.status,
      });
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, connection))!;
    expect(await log.readToHead()).toBe(true);
    expect(await log.readToHead(), 'nothing new is still read to the head').toBe(true);
    busy = true;
    expect(await log.readToHead()).toBe(false);
    busy = false;
    generation = 'restored';
    expect(await log.readToHead(), 'the pass that met the new generation').toBe(false);
    expect(log.generationChanges).toBe(1);
    expect(await log.readToHead(), 'the next pass, after the write-back').toBe(true);
  });

  /** README: after a restore, a device "writes back what the snapshot lacks" — it rewrote every row it held. */
  it('writes back only what a restored log lacks', async () => {
    let server = await edge([row(1), row(2), row(3), row(4)]);
    let generation = 'original';
    const sent: number[] = [];
    const connection: typeof fetch = async (url, init) => {
      if (init?.method === 'POST')
        sent.push((JSON.parse(String(init.body)) as { writes: unknown[] }).writes.length);
      const res = await server.fetchImpl(url, init);
      return new Response(JSON.stringify({ ...(await res.json()), generation }), {
        status: res.status,
      });
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, connection))!;
    server = await edge([row(1), row(2), row(3)]);
    generation = 'restored';
    expect(await log.refresh()).toBe(true);
    expect(
      sent.reduce((a, b) => a + b, 0),
      'only row 4',
    ).toBe(1);
    const reopened = (await LibraryLog.open(LIBRARY_KEY, connection))!;
    expect(reopened.rows()).toHaveLength(4);
  });

  it('skips an unreadable incremental row and still reaches later changes', async () => {
    const server = await edge();
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl))!;
    server.stored.set('bad', { k: 'ab'.repeat(32), seq: 1, v: 'AAAA' });
    const keys = await deriveKeys(Uint8Array.from(atob(LIBRARY_KEY), (c) => c.charCodeAt(0)));
    const good = await seal(keys, currentRows([row(11)])[0]!);
    server.stored.set(good.k, { ...good, seq: 2 });
    expect(await log.refresh()).toBe(true);
    expect(log.title({ type: 'movie', id: 11 })?.status.value).toBe('watchlist');
  });

  it('serializes concurrent same-row saves without losing either field', async () => {
    const { fetchImpl } = await edge();
    const log = (await LibraryLog.open(LIBRARY_KEY, fetchImpl))!;
    const blank = blankTitle({ type: 'movie', id: 10 }, 0);
    await Promise.all([
      log.write(addToWatchlist(blank, at(1000, 'web'))),
      log.write(react(blank, 'love', at(2000, 'web'))),
    ]);
    const restored = (await LibraryLog.open(LIBRARY_KEY, fetchImpl))!.title(blank.title)!;
    expect(restored.status.value).toBe('watchlist');
    expect(restored.reaction.value).toBe('love');
  });

  it('reads every page and opens each row, skipping one that does not open', async () => {
    const rows = [row(1), row(2), row(3)];
    const { fetchImpl } = await edge(rows, [{ k: 'ab'.repeat(32), v: 'AAAA' }]);
    const log = (await LibraryLog.open(LIBRARY_KEY, fetchImpl))!;
    expect(rows.map(({ title }) => log.title(title)?.status.value)).toEqual([
      'watchlist',
      'watchlist',
      'watchlist',
    ]);
  });

  it('is empty for a library nobody wrote, and null when den-edge is out of reach', async () => {
    expect(
      (await LibraryLog.open(LIBRARY_KEY, async () => new Response('{}', { status: 404 })))?.rows(),
    ).toEqual([]);
    expect(
      await LibraryLog.open(LIBRARY_KEY, async () => Promise.reject(new TypeError('offline'))),
    ).toBeNull();
    expect(
      await LibraryLog.open(LIBRARY_KEY, async () => new Response('{}', { status: 500 })),
    ).toBeNull();
  });

  it('says when the TV moved the library to a new key', async () => {
    const gone: typeof fetch = async () =>
      new Response('{"error":"library_moved"}', { status: 410 });
    const opened = await LibraryLog.open(LIBRARY_KEY, gone);
    expect([opened?.moved, opened?.rows()]).toEqual([true, []]);

    const { fetchImpl } = await edge();
    const log = await LibraryLog.open(LIBRARY_KEY, async (input, init) =>
      init?.method === 'POST' ? gone(input, init) : fetchImpl(input, init),
    );
    expect(log?.moved).toBe(false);
    expect(
      await log!.write(addToWatchlist(blankTitle({ type: 'tv', id: 1 }, 0), at(1))),
    ).toBeNull();
    expect(log?.moved).toBe(true);
  });

  it('knows the newest stamp it read', async () => {
    const server = await edge([
      row(1),
      row(2, { reaction: { value: 'love', at: at(9000, 'web1') } }),
    ]);
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl))!;
    await log.rowsInSlices();
    expect(log.newestStamp()).toEqual(at(9000, 'web1'));

    await server.append(row(3, { reaction: { value: 'love', at: at(10_000, 'phone') } }));
    expect(await log.refresh()).toBe(true);
    expect(log.newestStamp()).toEqual(at(10_000, 'phone'));

    expect(
      await log.writeRows([row(4, { reaction: { value: 'love', at: at(11_000, 'import') } })]),
    ).toBe(true);
    expect(log.newestStamp()).toEqual(at(11_000, 'import'));
  });

  it('shares one projected row snapshot until an entry changes', async () => {
    const server = await edge([row(1)]);
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl))!;
    const projected = await log.rowsInSlices();

    expect(log.rows()).toBe(projected);
    expect(log.rows()).toBe(projected);

    await server.append(row(2));
    expect(await log.refresh()).toBe(true);
    expect(log.rows()).not.toBe(projected);
  });

  it('keeps the newest cache correct across concurrent conflict merges', async () => {
    const server = await edge([row(1)]);
    const [phone, laptop] = await Promise.all([
      LibraryLog.open(LIBRARY_KEY, server.fetchImpl),
      LibraryLog.open(LIBRARY_KEY, server.fetchImpl),
    ]);
    await Promise.all([phone!.rowsInSlices(), laptop!.rowsInSlices()]);
    const ref = { type: 'movie' as const, id: 1 };

    await phone!.write(react(phone!.title(ref)!, 'love', at(12_000, 'phone')));
    await laptop!.write(addToWatchlist(laptop!.title(ref)!, at(13_000, 'laptop')));

    expect(laptop!.newestStamp()).toEqual(at(13_000, 'laptop'));
    await phone!.refresh();
    expect(phone!.newestStamp()).toEqual(at(13_000, 'laptop'));
  });

  it('writes a title new to the library, and a stale write merges on top of the row that beat it', async () => {
    const { fetchImpl } = await edge();
    const [phone, laptop] = [
      await LibraryLog.open(LIBRARY_KEY, fetchImpl),
      await LibraryLog.open(LIBRARY_KEY, fetchImpl),
    ];
    const ref = { type: 'movie' as const, id: 438631 };

    // The phone adds it; the laptop, which read the log before that, reacts to it.
    expect(
      await phone!.write(addToWatchlist(blankTitle(ref, 5000), at(5000, 'ph01'))),
    ).not.toBeNull();
    const stored = await laptop!.write(react(blankTitle(ref, 6000), 'love', at(6000, 'lt01')));
    expect(stored?.kind === 'rec' && [stored.status.value, stored.reaction.value]).toEqual([
      'watchlist',
      'love',
    ]);

    const reread = await LibraryLog.open(LIBRARY_KEY, fetchImpl);
    expect(reread?.title(ref)?.status.value).toBe('watchlist');
    expect(reread?.title(ref)?.reaction.value).toBe('love');
    expect(reread?.title(ref)?.addedAt).toBe(5000);
  });

  it('says so when a write cannot be saved', async () => {
    const { fetchImpl } = await edge();
    const log = await LibraryLog.open(LIBRARY_KEY, fetchImpl);
    const offline = await LibraryLog.open(LIBRARY_KEY, async (input, init) =>
      init?.method === 'POST' ? Promise.reject(new TypeError('offline')) : fetchImpl(input, init),
    );
    expect(log).not.toBeNull();
    expect(
      await offline!.write(addToWatchlist(blankTitle({ type: 'tv', id: 1 }, 0), at(1))),
    ).toBeNull();
  });
});

describe('a library kept only in this browser', () => {
  const LOCAL_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

  it('opens as an existing local library only after this vault created it', async () => {
    const { vault } = memoryVault();
    await expect(LibraryLog.openExistingLocal(LOCAL_KEY, vault)).resolves.toBeNull();
    const created = await LibraryLog.openLocal(LOCAL_KEY, vault);
    expect(created).not.toBeNull();
    const reopened = await LibraryLog.openExistingLocal(LOCAL_KEY, vault);
    expect(reopened).not.toBeNull();
    await created!.forget();
    await expect(LibraryLog.openExistingLocal(LOCAL_KEY, vault)).resolves.toBeNull();
  });

  it('prepares the newest maximum while projecting, so reads do not rescan the log', async () => {
    const { vault } = memoryVault();
    const log = (await LibraryLog.openLocal(LOCAL_KEY, vault))!;
    let traversals = 0;
    const fields = Object.fromEntries(
      Array.from({ length: 1000 }, (_, index) => [
        `field-${index}`,
        { value: { int: index }, at: at(14_000 - index, 'tv01') },
      ]),
    );
    const values = new Proxy(fields, {
      get(target, key, receiver) {
        traversals++;
        return Reflect.get(target, key, receiver);
      },
    });
    const settings: SettingsRow = { kind: 'set', schema: 2, name: 'counted', values };
    expect(await log.writeRows([settings])).toBe(true);
    expect(await log.rowsInSlices()).not.toBeNull();
    traversals = 0;

    expect(log.newestStamp()).toEqual(at(14_000, 'tv01'));
    expect(log.newestStamp()).toEqual(at(14_000, 'tv01'));
    // Before the cache, those two reads touched all 1,000 values twice; the prepared answer touches none.
    expect(traversals).toBe(0);
  });

  it('keeps what someone does with no TV, and asks den-edge nothing', async () => {
    const { vault } = memoryVault();
    const asked: string[] = [];
    const counting: typeof fetch = async (input) => {
      asked.push(String(input));
      return new Response('{}', { status: 500 });
    };
    const log = (await LibraryLog.openLocal(LOCAL_KEY, vault, counting))!;
    expect(await log.write(row(1))).not.toBeNull();
    const before = log.title({ type: 'movie', id: 1 })!;
    const journal = recordTrackerEvent(before, react(before, 'love', at(3000)), at(3000))!;
    expect(await log.writeActions([journal])).toBe(true);
    expect(await log.refresh()).toBe(false);
    await vi.waitFor(async () => {
      const again = (await LibraryLog.openLocal(LOCAL_KEY, vault, counting))!;
      expect(again.title({ type: 'movie', id: 1 })?.reaction.value).toBe('love');
    });
    expect(asked).toEqual([]);
  });

  it("moves into a TV's library, merged with what the TV has, and is then dropped", async () => {
    const { data, vault } = memoryVault();
    const server = await edge([row(2)]);
    const local = (await LibraryLog.openLocal(LOCAL_KEY, vault, server.fetchImpl))!;
    await local.write(addToWatchlist(blankTitle({ type: 'movie', id: 1 }, 1_000), at(1_000)));
    await local.write(markWatched(blankTitle({ type: 'movie', id: 2 }, 1_000), at(5_000)));
    expect(local.title({ type: 'movie', id: 1 })?.status.value).toBe('watchlist');
    expect(local.title({ type: 'movie', id: 2 })?.status.value).toBe('watched');
    expect(await local.moveTo(LIBRARY_KEY)).not.toBeNull();
    const tv = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    expect(tv.title({ type: 'movie', id: 1 })).toBeDefined();
    expect(tv.title({ type: 'movie', id: 2 })?.status.value).toBe('watched');
    expect(await local.forget()).toBe(true);
    expect([...data.keys()].some((key) => key.startsWith(`${local.libraryId}:`))).toBe(false);
  });
});

describe('applyLog', () => {
  const backup: Library = {
    records: [
      {
        title: { type: 'movie', id: 1, title: 'Dune', posterPath: '/d.jpg' },
        status: 'watchlist',
        progress: 0,
        progressAt: 0,
        addedAt: 500,
        deleted: false,
      },
    ],
    marks: [],
    shapes: new Map(),
    dismissed: new Map(),
  };

  it("takes the log's state over the backup's and keeps the backup's display", () => {
    const library = applyLog(backup, [
      row(1, {
        status: { value: 'inProgress', at: at(2000) },
        resume: { value: 0.4, at: at(2000), viewing: 0 },
      }),
    ]);
    expect(watchlist(library)).toEqual([]);
    expect(continueWatching(library)).toEqual([{ title: backup.records[0]!.title, fraction: 0.4 }]);
  });

  it('holds a title only the log knows until TMDB names it', () => {
    const library = applyLog(backup, [row(2, { addedAt: 3000 })]);
    expect(watchlist(library).map((t) => t.id)).toEqual([1]);
    expect(untitled(library)).toEqual([{ type: 'movie', id: 2 }]);
    const named = withDisplay(library, [{ type: 'movie', id: 2, title: 'Arrival' }]);
    expect(watchlist(named).map((t) => t.title)).toEqual(['Arrival', 'Dune']);
  });

  it('carries a dismissal from the log', () => {
    const dismissed = row(1, {
      status: { value: 'inProgress', at: at(2000) },
      resume: { value: 0.4, at: at(2000), viewing: 0 },
      dismissed: { value: true, at: at(2500) },
    });
    expect(continueWatching(applyLog(backup, [dismissed]))).toEqual([]);
  });

  const episode = (season: number, number: number, value: number, t: number): EpisodeRow => ({
    kind: 'ep',
    schema: 2,
    title: { type: 'tv', id: 95396 },
    season,
    episode: number,
    progress: { value, at: at(t), viewing: value === 0 ? 1 : 0 },
  });

  it('puts a series in Continue Watching from its episode rows, once it has a name', () => {
    const library = applyLog(backup, [episode(1, 2, 0.5, 4000)]);
    expect(untitled(library)).toEqual([{ type: 'tv', id: 95396 }]);
    const named = withDisplay(library, [
      { type: 'tv', id: 95396, title: 'Severance', posterPath: '/s.jpg', rating: 8.4 },
    ]);
    expect(continueWatching(named)[0]).toEqual({
      title: { type: 'tv', id: 95396, title: 'Severance', posterPath: '/s.jpg', rating: 8.4 },
      fraction: 0.5,
      episode: { season: 1, episode: 2 },
    });
  });

  it('drops an un-watched episode, and every episode from before a series reset', () => {
    const named = { ...backup, marks: [] };
    expect(applyLog(named, [episode(1, 2, 0.5, 4000), episode(1, 2, 0, 5000)]).marks).toEqual([]);
    const reset = row(95396, { title: { type: 'tv', id: 95396 }, episodesReset: at(4500) });
    const after = applyLog(named, [episode(1, 1, 1, 4000), episode(1, 2, 0.3, 5000), reset]);
    expect(after.marks.map((m) => m.episode)).toEqual([2]);
  });

  it('leaves out an episode row of a film, which den-core refuses, rather than failing the whole library', () => {
    const film = { ...episode(1, 2, 1, 4000), title: { type: 'movie' as const, id: 550 } };
    const library = applyLog(backup, [film, episode(1, 2, 0.5, 4000)]);
    expect(library.marks.map((m) => m.id)).toEqual([95396]);
  });
});

describe('tmdb', () => {
  const answer =
    (body: unknown): typeof fetch =>
    async () =>
      new Response(JSON.stringify(body), { status: 200 });
  const details = async (...args: Parameters<typeof fetchDetailsResult>) => {
    const result = await fetchDetailsResult(...args);
    return result.kind === 'found' ? result.details : null;
  };

  it('names a movie and a series from their details', async () => {
    const movie = {
      title: 'Arrival',
      poster_path: '/a.jpg',
      release_date: '2016-11-11',
      vote_average: 7.6,
    };
    expect(await details({ type: 'movie', id: 329865 }, 'k', answer(movie))).toEqual({
      title: {
        type: 'movie',
        id: 329865,
        title: 'Arrival',
        posterPath: '/a.jpg',
        year: 2016,
        releaseDate: '2016-11-11',
        rating: 7.6,
        ratingSource: 'tmdb',
      },
    });
    const series = await details(
      { type: 'tv', id: 95396 },
      'k',
      answer({ name: 'Severance', first_air_date: '2022-02-17' }),
    );
    expect(series?.title).toMatchObject({ title: 'Severance', year: 2022 });
    expect(
      await details({ type: 'tv', id: 1 }, 'k', async () => new Response('{}', { status: 401 })),
    ).toBeNull();
  });

  it("reads a series' season layout, so Continue Watching can find the next episode", async () => {
    const severance = {
      name: 'Severance',
      seasons: [
        { season_number: 0, episode_count: 2 },
        { season_number: 1, episode_count: 9 },
        { season_number: 2, episode_count: 10 },
      ],
      last_episode_to_air: { season_number: 2, episode_number: 4 },
    };
    const found = await details({ type: 'tv', id: 95396 }, 'k', answer(severance));
    expect(found?.shape).toEqual({
      counts: new Map([
        [0, 2],
        [1, 9],
        [2, 10],
      ]),
      lastAired: { season: 2, episode: 4 },
    });
  });
});
