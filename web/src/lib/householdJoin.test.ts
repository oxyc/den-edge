import { describe, expect, it } from 'vitest';
import {
  joinHousehold,
  joinKidOperation,
  type JoinHousehold,
  type JoinIO,
  type JoinState,
} from './householdJoin';
import type { DocumentRow } from './wire';

const id = (n: number) => n.toString(16).padStart(32, '0');
const doc = (name: string) => ({ kind: 'title', name }) as unknown as DocumentRow;
const nameOf = (document: DocumentRow) => (document as unknown as { name: string }).name;

/** den-edge and this device as the join sees them: libraries by key, the household joined, the Kid journal. */
function world(options: { destinationProfiles?: boolean; pin?: boolean; sourceKidName?: string }) {
  const libraries = new Map<string, Set<string>>([
    ['src-owner', new Set(['a', 'b'])],
    ['src-kid', new Set(['k1'])],
    ['src-household', new Set()],
    ['dst-owner', new Set(['a', 'z'])],
    ['dst-kid', new Set()],
    ['dst-household', new Set()],
  ]);
  const retired = new Set<string>();
  const source: JoinHousehold = {
    owner: { id: id(1), key: 'src-owner', name: 'Owner', maximumAge: null },
    kids: [{ id: id(2), key: 'src-kid', name: options.sourceKidName ?? 'Mia', maximumAge: 9 }],
  };
  const destinationKids = [{ id: id(11), key: 'dst-kid', name: 'Kids', maximumAge: 12 }];
  const journal = new Map<string, string>();
  let state: JoinState | null = null;
  let created = 0;
  const io: JoinIO = {
    state: async () => state,
    keep: async (next) => void (state = next),
    source: async () => (retired.has('src-household') ? 'gone' : source),
    destination: async () => ({
      profiles:
        options.destinationProfiles === false
          ? null
          : {
              owner: { id: id(10), key: 'dst-owner', name: 'Owner', maximumAge: null },
              kids: destinationKids,
            },
      pin: options.pin ?? true,
    }),
    pinMatches: async (pin) => pin === '1234',
    documents: async (key) => {
      if (retired.has(key)) return { documents: [], head: null };
      const library = libraries.get(key)!;
      return { documents: [...library].map(doc), head: library.size };
    },
    take: async (key, documents) => {
      const into = libraries.get(key ?? 'dst-household')!;
      for (const document of documents) into.add(nameOf(document));
      return true;
    },
    createKid: async (operationId, name, maximumAge) => {
      const existing = journal.get(operationId);
      if (existing) return existing;
      created += 1;
      const kid = id(100 + created);
      libraries.set(`key-${kid}`, new Set());
      destinationKids.push({ id: kid, key: `key-${kid}`, name, maximumAge });
      journal.set(operationId, kid);
      return kid;
    },
    retire: async (key, head) => {
      // den-edge refuses a retirement once the library moved past the head that was carried.
      if (key !== null && head !== libraries.get(key)!.size) return false;
      retired.add(key ?? 'src-household');
      return true;
    },
  };
  return {
    io,
    libraries,
    retired,
    destinationKids,
    created: () => created,
    state: () => state,
  };
}

/** `io` that stops (as a closed tab would) at its `at`-th change, counting every write it makes. */
function crashing(io: JoinIO, at: number): JoinIO {
  let writes = 0;
  const step =
    <T extends unknown[], R>(work: (...args: T) => Promise<R>) =>
    async (...args: T): Promise<R> => {
      if (writes++ === at) throw new Error('the tab closed');
      return work(...args);
    };
  return {
    ...io,
    keep: step(io.keep),
    take: step(io.take),
    createKid: step(io.createKid),
    retire: step(io.retire),
  };
}

describe('joinHousehold', () => {
  it('asks for the Owner PIN of the household joined before anything moves', async () => {
    const w = world({});
    expect(await joinHousehold(w.io)).toEqual({ outcome: 'pin-required' });
    expect(await joinHousehold(w.io, '0000')).toEqual({ outcome: 'pin-wrong' });
    expect([...w.libraries.get('dst-owner')!]).toEqual(['a', 'z']);
    expect(w.retired.size).toBe(0);
  });

  it('merges the Owner into the Owner, makes the Kid once, and retires the source household last', async () => {
    const w = world({});
    const answer = await joinHousehold(w.io, '1234');
    const kid = w.destinationKids.find((candidate) => candidate.name === 'Mia')!;
    expect(answer).toEqual({ outcome: 'joined', owner: id(10), kids: { [id(2)]: kid.id } });
    expect([...w.libraries.get('dst-owner')!].sort()).toEqual(['a', 'b', 'z']);
    expect([...w.libraries.get(kid.key)!]).toEqual(['k1']);
    expect(w.created()).toBe(1);
    expect([...w.retired]).toEqual(['src-kid', 'src-owner', 'src-household']);
  });

  it('merges a Kid into a Kid of the same name and age rather than making a second', async () => {
    const w = world({ sourceKidName: 'kids ' });
    w.destinationKids[0] = { ...w.destinationKids[0]!, maximumAge: 9 };
    const answer = await joinHousehold(w.io, '1234');
    expect(answer).toMatchObject({ outcome: 'joined', kids: { [id(2)]: id(11) } });
    expect(w.created()).toBe(0);
    expect([...w.libraries.get('dst-kid')!]).toEqual(['k1']);
  });

  it('needs no PIN where the household joined has none', async () => {
    const w = world({ pin: false });
    expect(await joinHousehold(w.io)).toMatchObject({ outcome: 'joined' });
  });

  it('refuses a household without profiles while a Kid has activity, changing nothing', async () => {
    const w = world({ destinationProfiles: false });
    expect(await joinHousehold(w.io)).toEqual({ outcome: 'refused-kids' });
    expect(w.libraries.get('dst-household')!.size).toBe(0);
    expect(w.retired.size).toBe(0);
  });

  it('takes only the Owner into a household without profiles when no Kid has activity', async () => {
    const w = world({ destinationProfiles: false });
    w.libraries.get('src-kid')!.clear();
    expect(await joinHousehold(w.io)).toEqual({ outcome: 'joined', owner: null, kids: {} });
    expect([...w.libraries.get('dst-household')!].sort()).toEqual(['a', 'b']);
    expect(w.retired.has('src-household')).toBe(true);
  });

  it('finishes a join cut off at any write exactly once, with nothing lost', async () => {
    for (let at = 0; ; at += 1) {
      const w = world({});
      let first;
      try {
        first = await joinHousehold(crashing(w.io, at), '1234');
      } catch {
        first = null;
      }
      if (first?.outcome === 'joined') break;
      // A reload: the PIN is asked again only when the first run stopped before it was accepted.
      const resumed = await joinHousehold(w.io);
      const answer =
        resumed.outcome === 'pin-required' ? await joinHousehold(w.io, '1234') : resumed;
      expect(answer.outcome, `cut at write ${at}`).toBe('joined');
      const kids = w.destinationKids.filter((kid) => kid.name === 'Mia');
      expect(kids, `cut at write ${at}`).toHaveLength(1);
      expect(w.created(), `cut at write ${at}`).toBe(1);
      expect([...w.libraries.get('dst-owner')!].sort()).toEqual(['a', 'b', 'z']);
      expect([...w.libraries.get(kids[0]!.key)!]).toEqual(['k1']);
      expect(w.retired.has('src-household')).toBe(true);
      expect(at).toBeLessThan(20);
    }
  });

  it('never retires before everything is proved carried', async () => {
    const w = world({});
    const io = { ...w.io, take: async () => false };
    expect(await joinHousehold(io, '1234')).toEqual({ outcome: 'unavailable' });
    expect(w.retired.size).toBe(0);
  });

  it('leaves a library written to after it was carried, and carries the write on the next run', async () => {
    const w = world({});
    const io: JoinIO = {
      ...w.io,
      take: async (key, documents) => {
        const taken = await w.io.take(key, documents);
        // The Owner keeps watching on another tab while the join runs.
        if (key === 'dst-owner') w.libraries.get('src-owner')!.add('late');
        return taken;
      },
    };
    expect(await joinHousehold(io, '1234')).toEqual({ outcome: 'unavailable' });
    expect(w.retired.has('src-owner')).toBe(false);
    expect(await joinHousehold(w.io)).toMatchObject({ outcome: 'joined' });
    expect(w.libraries.get('dst-owner')!.has('late')).toBe(true);
    expect(w.retired.has('src-household')).toBe(true);
  });

  it('uses one fixed operation id per source Kid', () => {
    expect(joinKidOperation(id(2))).toBe(`join:${id(2)}`);
  });
});
