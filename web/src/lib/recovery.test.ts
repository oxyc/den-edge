import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  abandon,
  begin,
  confirm,
  DeriveFailed,
  derive,
  deviceCouldNot,
  deviceSlug,
  redeemMessages,
  reportTiming,
  type Timing,
  dueAtLaunch,
  forgetMakesInThisTab,
  markReconciled,
  newCode,
  prepare,
  readCode,
  readRecovery,
  reconcile,
  redeem,
  seal,
  turnOff,
  unseal,
  type RecoveryContext,
  type RecoveryLog,
} from './recovery';
import { deriveKeys, fromHex, type SettingsRow, type Stamp } from './wire';

const vectors = JSON.parse(
  readFileSync(new URL('../../../spec/vectors/recovery-v1.json', import.meta.url), 'utf8'),
) as {
  libraryKey: string;
  codes: { input: string; parsed: { data?: string; error?: string } }[];
  entries: {
    random: string;
    data: string;
    code: string;
    locator: string;
    wrapKey: string;
    nonce: string;
    sealed: string;
  }[];
  swappedLocator: { sealed: string };
};

const SLOW = 60_000;
/** A derivation that reports its timing nowhere. */
const quiet = { op: 'redeem', report: () => {} } as const;

describe('den-spec recovery-v1 vectors', () => {
  it('makes and reads codes as the vectors do', () => {
    for (const entry of vectors.entries)
      expect(newCode(fromHex(entry.random))).toEqual({ code: entry.code, data: entry.data });
    for (const { input, parsed } of vectors.codes) expect(readCode(input), input).toEqual(parsed);
  });

  it(
    'derives, seals with a fixed nonce, and opens only under its own locator',
    async () => {
      const key = fromHex(vectors.libraryKey);
      for (const entry of vectors.entries) {
        const derived = await derive(entry.data, quiet);
        expect(derived.locator).toBe(entry.locator);
        expect([...derived.wrapKey]).toEqual([...fromHex(entry.wrapKey)]);
        expect(await seal(derived, key, 1790000000000, fromHex(entry.nonce))).toBe(entry.sealed);
        expect([...((await unseal(derived, entry.sealed)) ?? [])]).toEqual([...key]);
      }
      const first = await derive(vectors.entries[0]!.data, quiet);
      expect(await unseal(first, vectors.swappedLocator.sealed)).toBeNull();
    },
    SLOW,
  );
});

describe('a derivation that can’t finish (§3)', () => {
  /** A Worker that answers `reply` after `afterMs`, or never. */
  const fakeWorker =
    (reply?: Record<string, string>, afterMs = 0) =>
    () => {
      const worker = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        onerror: null,
        postMessage() {
          if (reply) setTimeout(() => worker.onmessage?.({ data: reply } as MessageEvent), afterMs);
        },
        terminate() {},
      };
      return worker as unknown as Worker;
    };

  it('times out, and is reported as a timeout with its time', async () => {
    const timings: Timing[] = [];
    const failed = derive('GEB2LP9UC63WQ95UNSLTXM', {
      op: 'redeem',
      worker: fakeWorker(),
      timeoutMs: 20,
      report: (t) => timings.push(t),
    });
    await expect(failed).rejects.toEqual(new DeriveFailed('timeout'));
    expect(timings).toHaveLength(1);
    expect(timings[0]).toMatchObject({ op: 'redeem', outcome: 'timeout' });
    expect(timings[0]!.ms).toBeGreaterThanOrEqual(15);
  });

  it('a Worker that could not grow its memory fails as memory, with the device message', async () => {
    const timings: Timing[] = [];
    const failed = derive('GEB2LP9UC63WQ95UNSLTXM', {
      op: 'make',
      worker: fakeWorker({ error: 'memory' }),
      report: (t) => timings.push(t),
    });
    await expect(failed).rejects.toEqual(new DeriveFailed('memory'));
    expect(timings[0]).toMatchObject({ op: 'make', outcome: 'memory' });
    expect(deviceCouldNot.make).toBe(
      'This device couldn’t make the code — try Den Web on a computer.',
    );
    expect(redeemMessages.device).toBe(
      'This device couldn’t open the code — try Den Web on a computer.',
    );
  });

  it('a slow answer within the timeout is reported as ok', async () => {
    const timings: Timing[] = [];
    const entry = vectors.entries[0]!;
    const derived = await derive(entry.data, {
      op: 'redeem',
      worker: fakeWorker({ locator: entry.locator, wrapKey: entry.wrapKey }, 30),
      timeoutMs: 1000,
      report: (t) => timings.push(t),
    });
    expect(derived.locator).toBe(entry.locator);
    expect(timings[0]).toMatchObject({ outcome: 'ok' });
  });

  it('reports a timing to den-edge with nothing of the code', async () => {
    const sent: { url: string; body: string }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), body: String(init?.body) });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    reportTiming({ op: 'make', outcome: 'ok', ms: 141.6 }, fetchImpl);
    await Promise.resolve();
    expect(sent[0]!.url).toBe('/recovery/timing');
    const body = JSON.parse(sent[0]!.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['device', 'ms', 'op', 'outcome']);
    expect(body).toMatchObject({ op: 'make', outcome: 'ok', ms: 142 });
    expect(body.device).toMatch(/^[a-z0-9-]{1,24}$/);
  });

  it('names the device as den-edge takes it: at most 24 of [a-z0-9-]', () => {
    expect(deviceSlug('iPhone · Safari')).toBe('iphone-safari');
    expect(deviceSlug('Android tablet · Firefox')).toBe('android-tablet-firefox');
    expect(deviceSlug('Chromebook · Chrome · something long')).toMatch(/^[a-z0-9-]{1,24}$/);
    expect(deviceSlug(' · ')).toBe('unknown');
  });
});

// ---- a household: one library row at den-edge, read and written compare-and-set by each device

class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

interface Server {
  seq: number;
  row: SettingsRow | undefined;
  devices: SettingsRow;
  entries: Map<string, { sealed: string; library: string; createdAt: number; opens: number }>;
  /** Called on each POST /recovery, with the library row as den-edge holds it then. */
  onPost?: (row: SettingsRow | undefined) => void;
  deleted: string[];
}

function server(): Server {
  return {
    seq: 0,
    row: undefined,
    devices: { kind: 'set', schema: 2, name: 'devices', values: {} },
    entries: new Map(),
    deleted: [],
  };
}

class FakeLog implements RecoveryLog {
  private seq = 0;
  private row: SettingsRow | undefined;
  readOnly = false;
  wireMinimum = 4;
  /** What the next read meets: den-edge's log answers, it is busy (a 503), or it changed generation. */
  read: 'ok' | 'busy' | 'generation' = 'ok';
  constructor(private readonly edge: Server) {}
  async readToHead() {
    await this.refresh();
    return this.read === 'ok';
  }
  settings(name: string) {
    return name === 'devices' ? this.edge.devices : this.row;
  }
  seqOf() {
    return this.seq;
  }
  async writeAt(row: SettingsRow, base: number) {
    if (base !== this.edge.seq) {
      await this.refresh();
      return false;
    }
    this.edge.seq++;
    this.edge.row = structuredClone(row);
    await this.refresh();
    return true;
  }
  /**
   * As `LibraryLog.refresh`: a busy log leaves what this device holds as it was, and a pass that meets a generation
   * change has not yet read the current row. Either way the row held here is stale.
   */
  async refresh() {
    if (this.read === 'busy') return false;
    if (this.read === 'generation') return true;
    this.seq = this.edge.seq;
    this.row = structuredClone(this.edge.row);
    return true;
  }
}

function edgeFetch(edge: Server, library: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status });
    if (path === '/recovery/open') {
      const entry = edge.entries.get(body.locator!);
      if (!entry) return json(404, { error: 'unknown_code' });
      entry.opens++;
      return json(200, { sealed: entry.sealed });
    }
    if (path.startsWith('/lib/')) return json(200, { entries: [], head: 0 });
    const mine = [...edge.entries].filter(([, e]) => e.library === library);
    if (method === 'GET')
      return json(200, {
        entries: mine.map(([locator, e]) => ({
          locator,
          createdAt: e.createdAt,
          opens: e.opens,
          lastOpenedAt: null,
        })),
      });
    if (method === 'POST') {
      edge.onPost?.(edge.row);
      if (edge.entries.has(body.locator!)) return json(409, { error: 'locator_taken' });
      if (mine.length >= 4) return json(409, { error: 'recovery_full' });
      edge.entries.set(body.locator!, { sealed: body.sealed!, library, createdAt: 1, opens: 0 });
      return json(201, { createdAt: 1 });
    }
    const had = edge.entries.get(body.locator!)?.library === library;
    if (had) edge.entries.delete(body.locator!);
    edge.deleted.push(body.locator!);
    return json(200, { deleted: had });
  }) as typeof fetch;
}

const LIBRARY_KEY = btoa(String.fromCharCode(...fromHex(vectors.libraryKey)));

async function device(edge: Server, id: string, name: string, at = { now: 1_000_000 }) {
  const keys = await deriveKeys(fromHex(vectors.libraryKey));
  edge.devices.values[`${id}.name`] = { value: { string: name }, at: [1, 0, id] };
  let counter = 0;
  const ctx: RecoveryContext = {
    log: new FakeLog(edge),
    libraryId: keys.id,
    memberProof: `${keys.id}:${keys.member}`,
    device: id,
    issue: (): Stamp => [at.now, counter++, id],
    fetchImpl: edgeFetch(edge, keys.id),
    now: () => at.now,
    storage: new MemoryStorage() as unknown as Storage,
  };
  await ctx.log.readToHead();
  return ctx;
}

const TV = '00000000000000a1';
const WEB = '00000000000000b2';

describe('making a code (§6)', () => {
  it(
    'names the entry pending in the library before den-edge holds it, then makes it live',
    async () => {
      const edge = server();
      const web = await device(edge, WEB, 'Mac · Safari');
      const prepared = await prepare(web, LIBRARY_KEY);
      let atPost: string | undefined;
      edge.onPost = (row) => (atPost = readRecovery(row).get(prepared.locator)?.state);
      const begun = await begin(web, prepared);
      expect(begun.ok).toBe(true);
      expect(atPost).toBe('pending');
      if (!begun.ok) return;
      expect(await confirm(web, prepared, begun.baseLive)).toEqual({ ok: true });
      // A lost reply may make the service retry after the live compare-and-set already committed.
      expect(await confirm(web, prepared, begun.baseLive)).toEqual({ ok: true });
      begun.done();
      expect(readRecovery(edge.row).get(prepared.locator)?.state).toBe('live');
      expect(edge.entries.has(prepared.locator)).toBe(true);
      // The code opens the library on a new device.
      expect(await redeem(prepared.code, web.fetchImpl)).toEqual({ libraryKey: LIBRARY_KEY });
    },
    SLOW,
  );

  it(
    'a make abandoned after the POST (a crash) is nulled and deleted by the next reconcile',
    async () => {
      const edge = server();
      const clock = { now: 1_000_000 };
      const web = await device(edge, WEB, 'Mac · Safari', clock);
      const prepared = await prepare(web, LIBRARY_KEY);
      // The tab dies: its make never finishes and its heartbeat stops.
      const begun = await begin(web, prepared);
      if (!begun.ok) throw new Error('begin failed');
      clock.now += 5 * 60_000;
      forgetMakesInThisTab();
      const relaunched = { ...web, storage: web.storage, log: new FakeLog(edge) };
      const status = await reconcile(relaunched);
      expect(status?.notices).toContain(
        'Your recovery code setup didn’t finish. The code you saw doesn’t work; make a new one.',
      );
      expect(readRecovery(edge.row).has(prepared.locator)).toBe(false);
      expect(edge.entries.has(prepared.locator)).toBe(false);
      begun.done();
    },
    SLOW,
  );

  it(
    'a make that loses to one confirmed meanwhile on another device ends its own entry',
    async () => {
      const edge = server();
      const web = await device(edge, WEB, 'Mac · Safari');
      const tv = await device(edge, TV, 'Living room');
      const mine = await prepare(web, LIBRARY_KEY);
      const theirs = await prepare(tv, LIBRARY_KEY);
      const a = await begin(web, mine);
      const b = await begin(tv, theirs);
      if (!a.ok || !b.ok) throw new Error('begin failed');
      expect(await confirm(tv, theirs, b.baseLive)).toEqual({ ok: true });
      expect(await confirm(web, mine, a.baseLive)).toEqual({
        ok: false,
        lost: 'This code wasn’t saved — discard it, a code was just made on Living room.',
      });
      const row = readRecovery(edge.row);
      expect(row.get(theirs.locator)?.state).toBe('live');
      expect(row.has(mine.locator)).toBe(false);
      expect(edge.entries.has(mine.locator)).toBe(false);
      expect(edge.entries.has(theirs.locator)).toBe(true);
      // The web browser is told its code was replaced, once.
      const status = await reconcile(web);
      expect(status?.live?.byName).toBe('Living room');
    },
    SLOW,
  );

  it(
    'replacing a code ends the old one, and turning off ends the live one',
    async () => {
      const edge = server();
      const web = await device(edge, WEB, 'Mac · Safari');
      const first = await prepare(web, LIBRARY_KEY);
      const a = await begin(web, first);
      if (!a.ok) throw new Error('begin failed');
      await confirm(web, first, a.baseLive);
      const second = await prepare(web, LIBRARY_KEY);
      const b = await begin(web, second);
      if (!b.ok) throw new Error('begin failed');
      await confirm(web, second, b.baseLive);
      expect(edge.entries.has(first.locator)).toBe(false);
      expect(readRecovery(edge.row).has(first.locator)).toBe(false);
      expect(await turnOff(web)).toBe(true);
      expect(readRecovery(edge.row).size).toBe(0);
      expect(edge.entries.size).toBe(0);
    },
    SLOW,
  );

  it(
    'leaving without confirming nulls the pending entry and deletes it',
    async () => {
      const edge = server();
      const web = await device(edge, WEB, 'Mac · Safari');
      const prepared = await prepare(web, LIBRARY_KEY);
      const begun = await begin(web, prepared);
      if (!begun.ok) throw new Error('begin failed');
      await abandon(web, prepared.locator);
      begun.done();
      expect(readRecovery(edge.row).size).toBe(0);
      expect(edge.entries.size).toBe(0);
    },
    SLOW,
  );
});

describe('reconcile (§7)', () => {
  const live = (library: string, sealed = 'AAAA') =>
    JSON.stringify({ state: 'live', library, sealed, createdAt: 900_000, by: TV });

  it('posts a live entry den-edge lost again, unchanged', async () => {
    const edge = server();
    const web = await device(edge, WEB, 'Mac · Safari');
    const locator = 'ab'.repeat(16);
    edge.row = {
      kind: 'set',
      schema: 2,
      name: 'recovery',
      values: { [locator]: { value: { string: live(web.libraryId) }, at: [1, 0, TV] } },
    };
    edge.seq = 1;
    const status = await reconcile(web);
    expect(edge.entries.get(locator)?.sealed).toBe('AAAA');
    expect(status?.live).toMatchObject({
      locator,
      reposted: true,
      opens: 0,
      byName: 'another device',
    });
    expect(status?.broken).toBe(false);
  });

  it('deletes a listed entry the row does not name, and nulls another library’s', async () => {
    const edge = server();
    const web = await device(edge, WEB, 'Mac · Safari');
    const stray = 'cd'.repeat(16);
    const foreign = 'ef'.repeat(16);
    edge.entries.set(stray, { sealed: 'BBBB', library: web.libraryId, createdAt: 1, opens: 0 });
    edge.row = {
      kind: 'set',
      schema: 2,
      name: 'recovery',
      values: { [foreign]: { value: { string: live('0'.repeat(32)) }, at: [1, 0, TV] } },
    };
    edge.seq = 1;
    const status = await reconcile(web);
    expect(edge.entries.has(stray)).toBe(false);
    expect(edge.row?.values[foreign]?.value).toBeNull();
    expect(status?.live).toBeNull();
  });

  it('a read-only library is reconciled at den-edge without writing the row', async () => {
    const edge = server();
    const web = await device(edge, WEB, 'Mac · Safari');
    (web.log as FakeLog).readOnly = true;
    const foreign = 'ef'.repeat(16);
    edge.row = {
      kind: 'set',
      schema: 2,
      name: 'recovery',
      values: { [foreign]: { value: { string: live('0'.repeat(32)) }, at: [1, 0, TV] } },
    };
    edge.seq = 1;
    await reconcile(web);
    expect(edge.seq).toBe(1);
  });

  it('tells this browser once when the live code changed or ended elsewhere', async () => {
    const edge = server();
    const web = await device(edge, WEB, 'Mac · Safari');
    const first = 'ab'.repeat(16);
    edge.row = {
      kind: 'set',
      schema: 2,
      name: 'recovery',
      values: { [first]: { value: { string: live(web.libraryId) }, at: [1, 0, TV] } },
    };
    edge.seq = 1;
    edge.entries.set(first, { sealed: 'AAAA', library: web.libraryId, createdAt: 1, opens: 0 });
    expect((await reconcile(web))?.notices).toEqual([]);
    edge.row = { ...edge.row, values: { [first]: { value: null, at: [2, 0, TV] } } };
    edge.seq = 2;
    expect((await reconcile(web))?.notices).toEqual([
      'Your recovery code was turned off on another device.',
    ]);
    expect((await reconcile(web))?.notices).toEqual([]);
  });

  it('runs at launch at most once a day, and only a reconcile that succeeded uses up the day', () => {
    const storage = new MemoryStorage() as unknown as Storage;
    const day = 86_400_000;
    expect(dueAtLaunch('lib', day, storage)).toBe(true);
    expect(dueAtLaunch('lib', day + 1, storage), 'nothing succeeded yet').toBe(true);
    markReconciled('lib', day, storage);
    expect(dueAtLaunch('lib', 2 * day - 1, storage)).toBe(false);
    expect(dueAtLaunch('lib', 2 * day, storage)).toBe(true);
    expect(dueAtLaunch('other', 2 * day, storage)).toBe(true);
  });

  /**
   * A browser last saw C1 live; meanwhile another device replaced it with C2. When this pass cannot read the log to
   * its head — den-edge busy (a 503 on the bulk lane while `/recovery` answers), or a generation change — acting on the
   * cached row would delete C2 (the person's code) and post C1 (the replaced one) again. It must do nothing.
   */
  for (const read of ['busy', 'generation'] as const) {
    it(`does nothing on a row it could not read to the head (${read})`, async () => {
      const edge = server();
      const c1 = 'ab'.repeat(16);
      const c2 = 'cd'.repeat(16);
      const keys = await deriveKeys(fromHex(vectors.libraryKey));
      edge.row = {
        kind: 'set',
        schema: 2,
        name: 'recovery',
        values: { [c1]: { value: { string: live(keys.id) }, at: [1, 0, TV] } },
      };
      edge.seq = 1;
      const web = await device(edge, WEB, 'Mac · Safari');
      edge.row = {
        kind: 'set',
        schema: 2,
        name: 'recovery',
        values: {
          [c1]: { value: null, at: [2, 0, TV] },
          [c2]: { value: { string: live(keys.id, 'CCCC') }, at: [2, 0, TV] },
        },
      };
      edge.seq = 2;
      edge.entries.set(c2, { sealed: 'CCCC', library: keys.id, createdAt: 2, opens: 0 });
      (web.log as FakeLog).read = read;
      const status = await reconcile(web);
      expect(edge.deleted, 'the current code is not deleted').toEqual([]);
      expect([...edge.entries.keys()], 'the replaced code is not posted again').toEqual([c2]);
      expect(edge.seq).toBe(2);
      expect(status).toBeNull();
    });
  }
});

describe('making waits and storage', () => {
  it('making a code waits on a library not yet on v4', async () => {
    const edge = server();
    const web = await device(edge, WEB, 'Mac · Safari');
    (web.log as FakeLog).wireMinimum = 3;
    const begun = await begin(web, {
      code: 'x',
      locator: 'ab'.repeat(16),
      sealed: 'AAAA',
      createdAt: 1,
      lastGroup: 'XXXX',
    });
    expect(begun).toEqual({ ok: false, error: 'waits' });
    expect(edge.seq).toBe(0);
    expect(edge.entries.size).toBe(0);
  });

  it(
    'a make where storage throws does not take its own pending entry for abandoned',
    async () => {
      const edge = server();
      const web = await device(edge, WEB, 'Mac · Safari');
      web.storage = {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      } as unknown as Storage;
      // Four strays of this library fill it, so the POST is refused and the make reconciles.
      for (const n of [1, 2, 3, 4])
        edge.entries.set(`${n}`.repeat(32), {
          sealed: 'BBBB',
          library: web.libraryId,
          createdAt: 1,
          opens: 0,
        });
      const prepared = await prepare(web, LIBRARY_KEY);
      const begun = await begin(web, prepared);
      if (!begun.ok) throw new Error(`begin failed: ${begun.error}`);
      expect(readRecovery(edge.row).get(prepared.locator)?.state).toBe('pending');
      expect(edge.entries.has(prepared.locator)).toBe(true);
      expect(await confirm(web, prepared, begun.baseLive)).toEqual({ ok: true });
      begun.done();
    },
    SLOW,
  );
});

describe('redeeming (§8)', () => {
  it('refuses a typo before any request', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response('{}');
    }) as typeof fetch;
    expect(await redeem('GEB2-LP9U-C63W-Q95U-NSLT-XMFA', fetchImpl)).toEqual({ error: 'checksum' });
    expect(await redeem('GEB2-LP9U', fetchImpl)).toEqual({ error: 'mistyped' });
    expect(asked).toEqual([]);
  });

  it(
    'reports an unknown code, a rate limit and a moved library as the spec words them',
    async () => {
      const code = vectors.entries[0]!.code;
      const answer = (status: number, extra: Record<string, string> = {}) =>
        (async () => new Response('{}', { status, headers: extra })) as typeof fetch;
      expect(await redeem(code, answer(404))).toEqual({ error: 'unknown_code' });
      expect(await redeem(code, answer(429, { 'retry-after': '600' }))).toEqual({
        error: 'rate_limited',
        retryAfter: 600,
      });
      const moved = (async (input: RequestInfo | URL) =>
        String(input) === '/recovery/open'
          ? new Response(JSON.stringify({ sealed: vectors.entries[0]!.sealed }))
          : new Response('{"error":"library_moved"}', { status: 410 })) as typeof fetch;
      expect(await redeem(code, moved)).toEqual({ error: 'library_moved' });
    },
    SLOW,
  );
});
