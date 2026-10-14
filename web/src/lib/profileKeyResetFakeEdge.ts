import type { Moving } from './log';
import { validateStoredProfileDirectory, type ProfileDirectoryDocument } from './profileDirectory';
import type { ProfileResetLibrary, ProfileResetSnapshot } from './profileKeyResetBackend';
import { sameDirectory } from './profileKeyResetExecutor';
import { profileResetHeadersAllowed, profileResetRoute } from './profileKeyResetRoutes';
import { profileMigrationDigest } from './profileMigrationCore';
import { syncPolicy } from './syncCore';
import { deriveKeys, rowName, toBase64url, type Row } from './wire';

/*
 * Test double for den-edge's profiles-v1 §9.1 surface: an in-memory store of libraries, the household record that is
 * the single authority over a reset, subordinate member locks, tombstones and the sweep. It follows the spec's order
 * of checks and its exact refusals, so the backend is exercised against the contract rather than against itself.
 */

/** A process death: the effect may or may not have landed, and the response is never seen. */
export class Killed extends Error {}

type Reply = { status: number; body: unknown };
type Body = Record<string, unknown>;
const ok = (body: unknown): Reply => ({ status: 200, body });
const refuse = (status: number, error: string): Reply => ({ status, body: { error } });
const inProgress = (): Reply => refuse(409, 'migration_in_progress');

interface Member {
  libraryId: string;
  successor: string;
}

interface Reset {
  attempt: string;
  owner: string;
  phase: 'open' | 'committed' | 'retiring' | 'retired' | 'aborted';
  source: { generation: number; head: string };
  successor: string;
  members: Member[];
  proven: boolean;
  preexisting: Set<string>;
  acquired: Set<string>;
  /** attempt → the recovery that took it over */
  recoveredBy: Map<string, string>;
  outcomes: Map<string, 'aborted' | 'retired'>;
  /** The stored answer of every recovery attempt, by attempt. */
  recoveries: Map<string, Body>;
  acquireBody: Body;
}

export interface FakeLibraryRecord {
  id: string;
  label: string;
  token: string;
  member: string;
  wire: 4 | 5;
  rows: Map<string, string>;
  dir: ProfileDirectoryDocument | null;
  gen: number;
  retired: { attempt: string; successor: string } | null;
  lock: { attempt: string; successor: string; household: string; body: Body } | null;
  reset: Reset | null;
  /** Acquire requests and their answers by attempt: a replay is answered from here, whatever changed since. */
  stored: Map<string, { request: Body; answer: Body }>;
}

const base64url = (text: string) =>
  btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

async function sha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface Fault {
  /** `${label} ${method} ${kind}`, e.g. `H POST successor`, or `${label} takeMoved`. */
  readonly on: string;
  readonly when: 'before' | 'after';
  /** The Nth matching call (1-based, default 1). */
  readonly nth?: number;
}

export class FakeEdge {
  readonly libs = new Map<string, FakeLibraryRecord>();
  readonly log: string[] = [];
  readonly faults: Fault[] = [];
  /** Set by a fault: every call fails until the test revives the edge, as a dead process would. */
  dead = false;
  /** Fail the next N matching requests with a 503 before they have any effect. */
  readonly serverErrors = new Map<string, number>();
  /** Make the next GET source of a library answer a head that is not its rows (a write landed between the reads). */
  readonly staleSource = new Set<string>();
  /** Make the next takeMoved into a library fail without writing. */
  readonly failMove = new Set<string>();
  /** The successor libraries a move may create, by id. */
  readonly planned = new Map<string, { label: string; key: string }>();
  readonly counts = new Map<string, number>();
  private lockCounter = 0;

  async add(
    label: string,
    key: string,
    wire: 4 | 5,
    names: string[],
    dir: ProfileDirectoryDocument | null = null,
  ): Promise<FakeLibraryRecord> {
    const keys = await deriveKeys(rawKey(key));
    const record: FakeLibraryRecord = {
      id: keys.id,
      label,
      token: keys.token,
      member: keys.member,
      wire,
      rows: new Map(names.map((name) => [name, 'v0'])),
      dir,
      gen: 1,
      retired: null,
      lock: null,
      reset: null,
      stored: new Map(),
    };
    this.libs.set(keys.id, record);
    return record;
  }

  /** Tell the edge which successor library a move may create, and under which label. */
  async plan(label: string, key: string): Promise<void> {
    this.planned.set((await deriveKeys(rawKey(key))).id, { label, key });
  }

  revive(): void {
    this.dead = false;
  }

  lib(label: string): FakeLibraryRecord {
    const found = [...this.libs.values()].find((lib) => lib.label === label);
    if (!found) throw new Error(`no library ${label}`);
    return found;
  }

  has(label: string): boolean {
    return [...this.libs.values()].some((lib) => lib.label === label);
  }

  labelOf(id: string): string {
    return this.libs.get(id)?.label ?? this.planned.get(id)?.label ?? id.slice(0, 6);
  }

  count(name: string): number {
    const next = (this.counts.get(name) ?? 0) + 1;
    this.counts.set(name, next);
    return next;
  }

  // -- state ----------------------------------------------------------------------------------------------------

  private governing(lib: FakeLibraryRecord): Reset | null {
    if (lib.reset) return lib.reset;
    return lib.lock ? (this.libs.get(lib.lock.household)?.reset ?? null) : null;
  }

  /** profiles-v1 §9.1 *Void locks*: a lock is in force only while its household record is non-terminal. */
  locked(lib: FakeLibraryRecord): boolean {
    if (lib.retired) return false;
    const reset = this.governing(lib);
    if (!reset || (!lib.reset && !lib.lock)) return false;
    return reset.phase === 'open' || reset.phase === 'committed' || reset.phase === 'retiring';
  }

  /** An ordinary write, as any other device would make it. */
  write(label: string, name: string): boolean {
    const lib = this.lib(label);
    if (lib.retired || this.locked(lib)) return false;
    lib.rows.set(name, `w${lib.gen}`);
    lib.gen += 1;
    return true;
  }

  private async rowsOf(lib: FakeLibraryRecord) {
    const rows = await Promise.all(
      [...lib.rows.entries()].map(async ([name, value]) => ({
        k: await sha(`set:${name}`),
        v: base64url(`${name}=${value}`),
      })),
    );
    if (lib.dir) rows.push({ k: await sha('profiles'), v: base64url(JSON.stringify(lib.dir)) });
    return rows
      .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
      .map((row, index) => ({ ...row, seq: index + 1 }));
  }

  async source(lib: FakeLibraryRecord): Promise<{ generation: number; head: string }> {
    const rows = await this.rowsOf(lib);
    return {
      generation: lib.gen,
      head: profileMigrationDigest('source', {
        libraryId: lib.id,
        generation: lib.gen,
        base: rows.length,
        wireMin: lib.wire,
        rows,
      }),
    };
  }

  async snapshot(lib: FakeLibraryRecord): Promise<ProfileResetSnapshot> {
    const rows = await this.rowsOf(lib);
    return {
      base: rows.length,
      generation: String(lib.gen),
      rows,
      names: [...lib.rows.keys()].map((name) => `set:${name}`),
      directory: lib.dir,
    };
  }

  // -- routes ---------------------------------------------------------------------------------------------------

  async handle(
    lib: FakeLibraryRecord,
    token: string,
    wire: number,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: unknown,
    headers: Readonly<Record<string, string>>,
  ): Promise<Reply> {
    if (token !== lib.token) return refuse(403, 'forbidden');
    if (wire !== lib.wire)
      return { status: 426, body: { error: 'upgrade_required', min: lib.wire } };
    const route = profileResetRoute(lib.id, method, path)!;
    switch (route.kind) {
      case 'source':
        return this.getSource(lib);
      case 'acquire':
        return this.acquire(lib, body as Body, headers);
      case 'lookup':
        return this.lookup(lib, route.attempt);
      case 'successor':
        return this.commit(lib, route.attempt, body as { successor: string });
      case 'abort':
        return this.abort(lib, route.attempt);
      case 'retire':
        return this.retire(lib, headers);
    }
  }

  private async getSource(lib: FakeLibraryRecord): Promise<Reply> {
    const source = await this.source(lib);
    if (this.staleSource.delete(lib.label))
      return ok({ source: { generation: source.generation + 1, head: source.head } });
    return ok({ source });
  }

  private async acquire(
    lib: FakeLibraryRecord,
    body: Body,
    headers: Readonly<Record<string, string>>,
  ): Promise<Reply> {
    if (body.purpose === 'key-reset-recovery') return this.takeOver(lib, body, headers);
    const attempt = String(body.attempt);
    // 1. Lookup first.
    const stored = lib.stored.get(attempt);
    if (stored)
      return JSON.stringify(body) === JSON.stringify(stored.request)
        ? ok(stored.answer)
        : refuse(409, 'migration_attempt_mismatch');
    // 2. A retired library.
    if (lib.retired) return refuse(410, 'library_moved');
    const current = await this.source(lib);
    const expected = body.expectedSource as { generation: number; head: string };
    const stale = expected.generation !== current.generation || expected.head !== current.head;

    if (body.role === 'household') {
      const members = body.members as Member[];
      const ids = [
        lib.id,
        String(body.successor),
        ...members.flatMap((m) => [m.libraryId, m.successor]),
      ];
      const sorted = members.every((m, i) => i === 0 || members[i - 1]!.libraryId < m.libraryId);
      if (lib.wire !== 5 || !members.length || new Set(ids).size !== ids.length || !sorted)
        return refuse(400, 'bad_request');
      // 3. Any other lock in force, before the source is compared.
      if (this.locked(lib)) return inProgress();
      // 4. A moved source.
      if (stale) return refuse(409, 'migration_source_changed');
      const reset: Reset = {
        attempt,
        owner: attempt,
        phase: 'open',
        source: expected,
        successor: String(body.successor),
        members,
        proven: false,
        preexisting: new Set(ids.filter((id) => id !== lib.id && this.libs.has(id))),
        acquired: new Set(),
        recoveredBy: new Map(),
        outcomes: new Map(),
        recoveries: new Map(),
        acquireBody: {},
      };
      const answer = {
        attempt,
        state: 'open',
        purpose: 'key-reset',
        role: 'household',
        library: lib.id,
        wireMin: 5,
        lock: `lock-${++this.lockCounter}`,
        fence: {
          generation: current.generation,
          base: (await this.rowsOf(lib)).length,
          head: current.head,
        },
        successor: reset.successor,
        members,
      };
      reset.acquireBody = answer;
      lib.reset = reset;
      lib.stored.set(attempt, { request: body, answer });
      return ok(answer);
    }

    const household = this.libs.get(String(body.household));
    const reset = household?.reset;
    if (
      !household ||
      !reset ||
      lib.wire !== 4 ||
      reset.phase !== 'open' ||
      reset.attempt !== attempt ||
      reset.owner !== attempt ||
      !reset.members.some((m) => m.libraryId === lib.id && m.successor === body.successor) ||
      this.locked(lib)
    )
      return inProgress();
    if (stale) return refuse(409, 'migration_source_changed');
    const answer = {
      attempt,
      state: 'open',
      purpose: 'key-reset',
      role: 'profile',
      library: lib.id,
      wireMin: 4,
      lock: `lock-${++this.lockCounter}`,
      fence: {
        generation: current.generation,
        base: (await this.rowsOf(lib)).length,
        head: current.head,
      },
      successor: body.successor,
      household: household.id,
    };
    lib.lock = {
      attempt,
      successor: String(body.successor),
      household: household.id,
      body: answer,
    };
    reset.acquired.add(lib.id);
    lib.stored.set(attempt, { request: body, answer });
    return ok(answer);
  }

  private async takeOver(
    lib: FakeLibraryRecord,
    body: Body,
    headers: Readonly<Record<string, string>>,
  ): Promise<Reply> {
    const recovery = String(body.attempt);
    const reset = lib.reset;
    // The same recovery attempt's repeat is looked up before any decision.
    const repeat = reset?.recoveries.get(recovery);
    if (repeat) return ok(repeat);
    if (!reset || body.role !== 'household' || lib.wire !== 5) return inProgress();
    if (reset.phase === 'aborted' || reset.phase === 'retired' || lib.retired) return inProgress();
    const current = await this.source(lib);
    const expected = body.expectedSource as { generation: number; head: string };
    if (
      expected.generation !== current.generation ||
      expected.head !== current.head ||
      expected.head !== reset.source.head
    )
      return inProgress();
    const proofToken = headers['x-den-successor-token'];
    let proof = false;
    if (proofToken !== undefined) {
      const successor = this.libs.get(reset.successor);
      if (!successor || successor.retired || successor.token !== proofToken) return inProgress();
      proof = true;
    }
    if (reset.phase === 'committed' && !proof) {
      // The proofless rollback: one commit on the household.
      reset.phase = 'aborted';
      reset.recoveredBy.set(reset.owner, recovery);
      this.settle(reset, recovery, 'aborted');
      const answer = { attempt: recovery, state: 'completed', outcome: 'aborted' };
      reset.recoveries.set(recovery, answer);
      this.sweep(reset);
      return ok(answer);
    }
    if (reset.phase === 'retiring' && !proof) return inProgress();
    const answer = {
      attempt: recovery,
      state: 'open',
      purpose: 'key-reset-recovery',
      role: 'household',
      library: lib.id,
      wireMin: 5,
      lock: reset.acquireBody.lock,
      fence: reset.acquireBody.fence,
      recovers: {
        attempt: reset.owner,
        phase: reset.phase,
        successor: reset.successor,
        members: reset.members,
      },
    };
    reset.recoveredBy.set(reset.owner, recovery);
    reset.owner = recovery;
    reset.proven = proof;
    reset.recoveries.set(recovery, answer);
    return ok(answer);
  }

  /** Every attempt in the chain of takeovers learns how it ended. */
  private settle(reset: Reset, finisher: string, outcome: 'aborted' | 'retired') {
    for (const name of new Set([
      reset.attempt,
      ...reset.recoveredBy.keys(),
      ...reset.recoveredBy.values(),
      finisher,
    ]))
      reset.outcomes.set(name, outcome);
  }

  /** den-edge deletes every declared successor that this reset can have created. */
  private sweep(reset: Reset) {
    for (const id of [reset.successor, ...reset.members.map((m) => m.successor)])
      if (!reset.preexisting.has(id)) this.libs.delete(id);
  }

  private lookup(lib: FakeLibraryRecord, attempt: string): Reply {
    if (lib.retired?.attempt === attempt)
      return ok({ attempt, state: 'retired', library: lib.id, successor: lib.retired.successor });
    const reset = lib.reset;
    if (!reset) {
      const lock = lib.lock;
      if (!lock || lock.attempt !== attempt) return refuse(404, 'not_found');
      if (this.libs.get(lock.household)?.reset?.phase === 'aborted')
        return ok({ attempt, state: 'aborted', library: lib.id });
      return ok(lock.body);
    }
    const original = attempt === reset.attempt;
    const recovery = reset.recoveries.get(attempt);
    if (!original && !recovery) return refuse(404, 'not_found');
    const takenBy = reset.recoveredBy.get(attempt);
    if (takenBy !== undefined) {
      const outcome = reset.outcomes.get(attempt);
      return ok({
        attempt,
        state: 'recovered',
        recovery: takenBy,
        ...(outcome ? { outcome } : {}),
      });
    }
    if (reset.phase === 'aborted')
      return ok(
        original
          ? { attempt, state: 'aborted', library: lib.id }
          : { attempt, state: 'completed', outcome: 'aborted' },
      );
    if (reset.phase === 'retired')
      return ok({ attempt, state: 'retired', library: lib.id, successor: reset.successor });
    const stored = recovery ?? reset.acquireBody;
    return ok({ ...stored, state: reset.phase === 'open' ? 'open' : 'committed' });
  }

  private commit(lib: FakeLibraryRecord, attempt: string, body: { successor: string }): Reply {
    const reset = lib.reset;
    if (!reset || reset.owner !== attempt || attempt !== reset.attempt) return inProgress();
    if (body.successor !== reset.successor) return refuse(409, 'migration_attempt_mismatch');
    if (reset.phase === 'committed' || reset.phase === 'retiring')
      return ok({ ...reset.acquireBody, state: 'committed' });
    if (reset.phase !== 'open') return inProgress();
    if (reset.members.some((m) => !reset.acquired.has(m.libraryId)))
      return refuse(409, 'locks_incomplete');
    const successor = this.libs.get(reset.successor);
    if (
      !successor ||
      successor.retired ||
      successor.wire < 5 ||
      successor.rows.size + (successor.dir ? 1 : 0) < 1
    )
      return refuse(409, 'successor_not_ready');
    reset.phase = 'committed';
    return ok({ ...reset.acquireBody, state: 'committed' });
  }

  private abort(lib: FakeLibraryRecord, attempt: string): Reply {
    const reset = lib.reset;
    if (!reset) return inProgress();
    const original = attempt === reset.attempt;
    const answer = original
      ? { attempt, state: 'aborted', library: lib.id }
      : { attempt, state: 'completed', outcome: 'aborted' };
    if (reset.phase === 'aborted' && (original || reset.recoveries.has(attempt))) return ok(answer);
    if (reset.owner !== attempt || reset.phase !== 'open') return inProgress();
    reset.phase = 'aborted';
    this.settle(reset, attempt, 'aborted');
    this.sweep(reset);
    return ok(answer);
  }

  private retire(lib: FakeLibraryRecord, headers: Readonly<Record<string, string>>): Reply {
    const attempt = headers['x-den-exclusive-attempt']!;
    const successor = headers['x-den-successor']!;
    const reset = this.governing(lib);
    // 1. Already retired by this lock: the owner, the acquirer and the current owner may replay.
    if (lib.retired) {
      const mine =
        lib.retired.attempt === attempt || reset?.owner === attempt || reset?.attempt === attempt;
      return mine && lib.retired.successor === successor
        ? ok({ deleted: true })
        : refuse(410, 'library_moved');
    }
    // 2. No lock in force.
    if (!reset || !this.locked(lib)) return refuse(409, 'lock_not_held');
    if (reset.owner !== attempt) return inProgress();
    if (reset.owner !== reset.attempt && !reset.proven) return inProgress();
    // 3. The declared successor.
    const declared = lib.reset
      ? reset.successor
      : reset.members.find((m) => m.libraryId === lib.id)?.successor;
    if (declared !== successor) return refuse(409, 'successor_mismatch');
    // 4. Nothing retires before the commit.
    if (reset.phase !== 'committed' && reset.phase !== 'retiring')
      return refuse(409, 'successor_not_committed');
    if (lib.reset) {
      // 5. The household is retired last.
      const retiredAll = reset.members.every((m) => this.libs.get(m.libraryId)?.retired);
      if (reset.phase !== 'retiring' || !retiredAll) return refuse(409, 'locks_held');
      reset.phase = 'retired';
      lib.retired = { attempt, successor };
      this.settle(reset, attempt, 'retired');
      return ok({ deleted: true });
    }
    // The retirement door is a household commit taken before the first member is retired.
    if (reset.phase === 'committed') reset.phase = 'retiring';
    lib.retired = { attempt, successor };
    return ok({ deleted: true });
  }

  /** A library handle as the worker opens it: this key's own token and wire. */
  open(key: string, wire: number): Promise<FakeLibrary> {
    return FakeLibrary.create(this, key, wire);
  }
}

function rawKey(key: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(key), (character) => character.charCodeAt(0));
}

export class FakeLibrary implements ProfileResetLibrary {
  private constructor(
    private readonly edge: FakeEdge,
    readonly libraryId: string,
    private readonly token: string,
    private readonly wire: number,
    readonly memberProof: string,
  ) {}

  static async create(edge: FakeEdge, key: string, wire: number): Promise<FakeLibrary> {
    const keys = await deriveKeys(rawKey(key));
    return new FakeLibrary(edge, keys.id, keys.token, wire, `${keys.id}:${keys.member}`);
  }

  private get record(): FakeLibraryRecord | undefined {
    return this.edge.libs.get(this.libraryId);
  }

  private fault(name: string, count: number, when: 'before' | 'after'): boolean {
    return this.edge.faults.some((f) => f.when === when && f.on === name && (f.nth ?? 1) === count);
  }

  resetRequest: ProfileResetLibrary['resetRequest'] = async (input) => {
    const route = profileResetRoute(this.libraryId, input.method, input.path);
    if (route === null || !profileResetHeadersAllowed(route, input.headers ?? {}))
      throw new Error('Profile key reset method, path or header is not allowed');
    const name = `${this.edge.labelOf(this.libraryId)} ${input.method} ${route.kind}`;
    if (this.edge.dead) throw new Killed();
    const count = this.edge.count(name);
    this.edge.log.push(name);
    const remaining = this.edge.serverErrors.get(name) ?? 0;
    if (remaining > 0) {
      this.edge.serverErrors.set(name, remaining - 1);
      return { status: 503, body: { error: 'unavailable' } };
    }
    if (this.fault(name, count, 'before')) {
      this.edge.dead = true;
      throw new Killed();
    }
    const record = this.record;
    if (!record) return { status: 404, body: { error: 'not_found' } };
    const reply = await this.edge.handle(
      record,
      this.token,
      this.wire,
      input.method,
      input.path,
      input.body,
      input.headers ?? {},
    );
    if (this.fault(name, count, 'after')) {
      this.edge.dead = true;
      throw new Killed();
    }
    return reply;
  };

  async resetSnapshot(): ReturnType<ProfileResetLibrary['resetSnapshot']> {
    const record = this.record;
    if (!record) return 'absent';
    if (record.retired) return 'moved';
    return this.edge.snapshot(record);
  }

  async moving(
    _device: string,
    options?: { replaceProfileDirectory?: boolean },
  ): ReturnType<ProfileResetLibrary['moving']> {
    const record = this.record;
    if (!record || record.retired) return { refused: 'unavailable' };
    if (record.dir && !options?.replaceProfileDirectory) return { refused: 'profiles' };
    const rows = [...record.rows.keys()].map(
      (name) => ({ kind: 'set', schema: 2, name, values: {} }) as unknown as Row,
    );
    return {
      rows,
      kept: [],
      head: rows.length,
      generation: String(record.gen),
      device: 'device',
      revokedGrants: [],
    };
  }

  async takeMoved(moving: Moving, member: string): Promise<boolean> {
    const label = this.edge.labelOf(this.libraryId);
    const name = `${label} takeMoved`;
    if (this.edge.dead) throw new Killed();
    const count = this.edge.count(name);
    this.edge.log.push(name);
    if (this.fault(name, count, 'before')) {
      this.edge.dead = true;
      throw new Killed();
    }
    if (this.edge.failMove.delete(label)) return false;
    let record = this.record;
    if (!record) {
      // NEW_LIBRARIES=members: a new library starts only with another library's member proof on the same store.
      const sponsor = [...this.edge.libs.values()].find(
        (lib) => `${lib.id}:${lib.member}` === member,
      );
      const planned = this.edge.planned.get(this.libraryId);
      if (!sponsor || !planned) return false;
      record = await this.edge.add(planned.label, planned.key, this.wire === 5 ? 5 : 4, []);
    }
    for (const row of moving.rows) record.rows.set(rowName(row).replace(/^set:/, ''), 'v0');
    for (const entry of moving.kept) {
      if (entry.name !== 'profiles') {
        record.rows.set(entry.name.replace(/^set:/, ''), 'v0');
        continue;
      }
      // The kept plaintext is the sealed form; den-core's decoder is what turns it back into the directory row.
      const decoded = syncPolicy<{ status: string; row?: unknown }>({
        op: 'doc_decode',
        plaintext: toBase64url(entry.plaintext),
      });
      const document = validateStoredProfileDirectory(decoded.row);
      // A repeated move meets its own directory; a different one is a conflict.
      if (record.dir && !sameDirectory(record.dir, document)) return false;
      record.dir = document;
    }
    record.gen += 1;
    if (this.fault(name, count, 'after')) {
      this.edge.dead = true;
      throw new Killed();
    }
    return true;
  }
}
