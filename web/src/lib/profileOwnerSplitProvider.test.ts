import { describe, expect, it, vi } from 'vitest';
import {
  DormantOwnerSplitEffectExecutor,
  type OwnerSplitDurableEvidence,
  type OwnerSplitSecureWorker,
} from './profileOwnerSplitEngine';
import {
  HttpOwnerSplitProvider,
  type OwnerSplitMigrationTransport,
} from './profileOwnerSplitProvider';

const HOUSEHOLD = '00112233445566778899aabbccddeeff';
const ATTEMPT = '0123456789abcdef0123456789abcdef';
const CANDIDATE = '11112222333344445555666677778888';
const DIGEST = 'a'.repeat(64);
const fence = { generation: 7, base: 4, head: DIGEST, rewrite: 'rewrite-7' };
const source = { generation: fence.generation, head: fence.head };
const bound = { attempt: ATTEMPT, id: 'backup-7', digest: DIGEST };
const ORIGINAL = 'f'.repeat(32);

describe('Owner split HTTP provider', () => {
  it('uses exact migration routes and never places credential material in a URL', async () => {
    const calls: unknown[] = [];
    const transport: OwnerSplitMigrationTransport = {
      request: vi.fn(async (input) => {
        calls.push(input);
        if (input.path.endsWith('/profile-migration/source')) return { source };
        if (input.path.endsWith('/retire-candidate')) return { result: 'retired' };
        if (input.path.endsWith('/rows')) return { stagedDigest: DIGEST };
        if (input.path.endsWith('/commit'))
          return {
            state: 'committed',
            attempt: ATTEMPT,
            purpose: 'split',
            wireMin: 5,
            fence,
            generation: 8,
            base: 5,
            head: 'b'.repeat(64),
            backup: { id: 'backup-7', digest: DIGEST },
            stagedDigest: DIGEST,
          };
        return {
          state: 'open',
          attempt: ATTEMPT,
          purpose: 'split',
          wireMin: 4,
          fence,
          backup: bound,
        };
      }),
      readHousehold: vi.fn(async () => ({
        kind: 'legacy' as const,
        generation: 8,
        base: 5,
        head: 'b'.repeat(64),
      })),
    };
    const provider = new HttpOwnerSplitProvider(HOUSEHOLD, transport);
    await expect(provider.observeSource()).resolves.toEqual(source);
    await expect(provider.open(ATTEMPT, 'split', source)).resolves.toMatchObject({
      state: 'open',
      backup: bound,
    });
    await provider.lookup(ATTEMPT);
    await provider.abort(ATTEMPT);
    await expect(
      provider.stage({
        attempt: ATTEMPT,
        fence,
        backup: { id: 'backup-7', digest: DIGEST },
        writes: [{ k: DIGEST, v: 'sealed' }],
      }),
    ).resolves.toBe(DIGEST);
    await expect(
      provider.commit({
        attempt: ATTEMPT,
        fence,
        backup: { id: 'backup-7', digest: DIGEST },
        stagedDigest: DIGEST,
      }),
    ).resolves.toMatchObject({ state: 'committed', wireMin: 5 });
    await provider.retireCandidate({
      attempt: ATTEMPT,
      source: fence,
      authority: {
        kind: 'legacy',
        generation: 8,
        base: 5,
        head: 'b'.repeat(64),
        profilesRow: { k: 'set:profiles', seq: 12, v: 'sealed', digest: 'c'.repeat(64) },
      },
      candidate: {
        profileId: HOUSEHOLD,
        libraryId: CANDIDATE,
        keyRef: 'secure-slot',
        keyFingerprint: DIGEST,
      },
      protectedLibraryIds: [],
    });
    expect(calls).toEqual([
      { method: 'GET', path: `/lib/${HOUSEHOLD}/profile-migration/source` },
      {
        method: 'POST',
        path: `/lib/${HOUSEHOLD}/profile-migration`,
        body: { attempt: ATTEMPT, purpose: 'split', expectedSource: source },
      },
      { method: 'GET', path: `/lib/${HOUSEHOLD}/profile-migration/${ATTEMPT}`, body: undefined },
      { method: 'DELETE', path: `/lib/${HOUSEHOLD}/profile-migration/${ATTEMPT}`, body: undefined },
      {
        method: 'POST',
        path: `/lib/${HOUSEHOLD}/profile-migration/${ATTEMPT}/rows`,
        body: {
          fence,
          backup: { id: 'backup-7', digest: DIGEST },
          writes: [{ k: DIGEST, v: 'sealed' }],
        },
      },
      {
        method: 'POST',
        path: `/lib/${HOUSEHOLD}/profile-migration/${ATTEMPT}/commit`,
        body: {
          fence,
          backup: { id: 'backup-7', digest: DIGEST },
          stagedDigest: DIGEST,
          wireMin: 5,
        },
      },
      expect.objectContaining({
        method: 'POST',
        path: `/lib/${HOUSEHOLD}/profile-migration/${ATTEMPT}/retire-candidate`,
        candidateKeyRef: 'secure-slot',
      }),
    ]);
    expect(JSON.stringify(calls)).not.toContain('libraryKey');
    expect(JSON.stringify(calls)).not.toContain('candidateToken');
    const retirement = calls.at(-1) as { body: Record<string, unknown> };
    expect(retirement.body.profilesRow).toEqual({ k: 'set:profiles', seq: 12, v: 'sealed' });
    expect(retirement.body.profilesRow).not.toHaveProperty('digest');
    expect(retirement.body.protectedLibraryIds).toEqual([HOUSEHOLD]);
  });

  it.each([
    ['missing wrapper', source],
    ['extra response member', { source, extra: true }],
    ['unsafe generation', { source: { ...source, generation: Number.MAX_SAFE_INTEGER + 1 } }],
    ['noncanonical head', { source: { ...source, head: 'A'.repeat(64) } }],
    ['extra source member', { source: { ...source, base: 4 } }],
  ])('rejects malformed source evidence: %s', async (_name, answer) => {
    const provider = new HttpOwnerSplitProvider(HOUSEHOLD, {
      request: vi.fn(async () => answer),
      readHousehold: vi.fn(),
    });
    await expect(provider.observeSource()).rejects.toThrow(/invalid migration source/);
  });

  it('validates terminal lookup shapes and carries the recovery wire minimum into restore', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const restoreFence = { ...fence, generation: 9, base: 6 };
    const transport: OwnerSplitMigrationTransport = {
      request: vi.fn(async (input) => {
        calls.push(input);
        if (!input.path.endsWith('/restore'))
          return {
            state: 'open',
            attempt: ATTEMPT,
            purpose: 'restore',
            wireMin: 5,
            fence: restoreFence,
            backup: { ...bound, attempt: ORIGINAL },
          };
        return {
          state: 'restored',
          attempt: ATTEMPT,
          purpose: 'restore',
          wireMin: 5,
          fence: restoreFence,
          generation: 10,
          base: 7,
          head: 'd'.repeat(64),
          backup: { id: 'backup-7', digest: DIGEST },
          stagedDigest: null,
        };
      }),
      readHousehold: vi.fn(),
    };
    const provider = new HttpOwnerSplitProvider(HOUSEHOLD, transport);
    const recovery = await provider.open(ATTEMPT, 'restore', source);
    expect(recovery).toMatchObject({
      state: 'open',
      purpose: 'restore',
      wireMin: 5,
      backup: { attempt: ORIGINAL },
    });
    if (recovery.state !== 'open' || recovery.purpose !== 'restore') throw new Error('bad fixture');
    const restored = await provider.restore({
      attempt: recovery.attempt,
      backup: { attempt: ORIGINAL, id: 'backup-7', digest: DIGEST },
      observation: { kind: 'corrupt', generation: 9, base: 6, head: 'e'.repeat(64) },
      plannerDecision: 'restore-backup',
    });
    expect(restored).toMatchObject({ state: 'restored', stagedDigest: null, wireMin: 5 });
    expect(calls.at(-1)?.body).toMatchObject({ wireMin: 5, fence: restoreFence });
    expect(calls.at(-2)).toEqual({
      method: 'GET',
      path: `/lib/${HOUSEHOLD}/profile-migration/${ATTEMPT}`,
      body: undefined,
    });
  });

  it('executes aborted unchanged-source cleanup through the real provider without client-asserted authority', async () => {
    let state: 'open' | 'aborted' = 'open';
    const calls: Array<{
      method: string;
      path: string;
      body?: unknown;
      candidateKeyRef?: string;
    }> = [];
    const transport: OwnerSplitMigrationTransport = {
      request: vi.fn(async (input) => {
        calls.push(input);
        if (input.path.endsWith('/retire-candidate')) return { result: 'retired' };
        if (input.method === 'DELETE') state = 'aborted';
        return { state, attempt: ATTEMPT, purpose: 'split', wireMin: 4, fence, backup: bound };
      }),
      readHousehold: vi.fn(async () => ({
        kind: 'legacy' as const,
        generation: fence.generation,
        base: fence.base,
        head: fence.head,
      })),
    };
    const secure: OwnerSplitSecureWorker = {
      prepareAuthorization: vi.fn(),
      bindAuthorization: vi.fn(),
      allocateCandidate: vi.fn(),
      verifyBackup: vi.fn(),
      copyAndAuthenticateOwner: vi.fn(),
      verifyOwnerLibrary: vi.fn(),
      planNext: vi.fn(),
      verifyCommittedWinner: vi.fn(),
      inspectCommittedDirectory: vi.fn(),
      verifyDirectoryWinner: vi.fn(),
      adoptWinner: vi.fn(),
      forgetCandidate: vi.fn(async () => {}),
    };
    const executor = new DormantOwnerSplitEffectExecutor({
      provider: new HttpOwnerSplitProvider(HOUSEHOLD, transport),
      secureWorker: secure,
      enabled: true,
    });
    const evidence: OwnerSplitDurableEvidence = {
      attempt: ATTEMPT,
      householdId: HOUSEHOLD,
      fence,
      backup: { id: 'backup-7', digest: DIGEST },
      candidate: {
        profileId: HOUSEHOLD,
        libraryId: CANDIDATE,
        keyRef: 'secure-candidate-slot',
        keyFingerprint: DIGEST,
      },
      ownerHead: DIGEST,
      householdWrites: [{ k: DIGEST, v: 'sealed' }],
    };

    const authority = await executor.abortWithFreshAuthority(ATTEMPT);
    await expect(
      executor.retireLoser(evidence, authority.household, authority.lookup),
    ).resolves.toBe('retired');
    const retirement = calls.at(-1)!;
    expect(retirement.path).toBe(`/lib/${HOUSEHOLD}/profile-migration/${ATTEMPT}/retire-candidate`);
    expect(retirement.candidateKeyRef).toBe('secure-candidate-slot');
    expect(retirement.body).not.toHaveProperty('attemptState');
    expect(retirement.body).not.toHaveProperty('aborted');
  });

  it.each([
    ['missing purpose', { state: 'open', attempt: ATTEMPT, wireMin: 4, fence }],
    ['missing wire minimum', { state: 'open', attempt: ATTEMPT, purpose: 'split', fence }],
    [
      'restored with a staged digest',
      {
        state: 'restored',
        attempt: ATTEMPT,
        purpose: 'restore',
        wireMin: 5,
        fence,
        generation: 8,
        base: 5,
        head: DIGEST,
        backup: { id: 'backup', digest: DIGEST },
        stagedDigest: DIGEST,
      },
    ],
    [
      'committed without a staged digest',
      {
        state: 'committed',
        attempt: ATTEMPT,
        purpose: 'split',
        wireMin: 5,
        fence,
        generation: 8,
        base: 5,
        head: DIGEST,
        backup: { id: 'backup', digest: DIGEST },
        stagedDigest: null,
      },
    ],
    [
      'superseded with incomplete winner evidence',
      {
        state: 'superseded',
        attempt: ATTEMPT,
        purpose: 'split',
        wireMin: 4,
        fence,
        winner: { attempt: 'f'.repeat(32), state: 'committed', head: DIGEST },
      },
    ],
  ])('rejects %s evidence instead of blindly casting it', async (_label, answer) => {
    const transport: OwnerSplitMigrationTransport = {
      request: vi.fn(async () => answer),
      readHousehold: vi.fn(),
    };
    await expect(new HttpOwnerSplitProvider(HOUSEHOLD, transport).lookup(ATTEMPT)).rejects.toThrow(
      'invalid migration attempt evidence',
    );
  });

  it('accepts complete superseded evidence with a restored winner and null staged digest', async () => {
    const winnerAttempt = 'f'.repeat(32);
    const transport: OwnerSplitMigrationTransport = {
      request: vi.fn(async () => ({
        state: 'superseded',
        attempt: ATTEMPT,
        purpose: 'split',
        wireMin: 4,
        fence,
        winner: {
          attempt: winnerAttempt,
          state: 'restored',
          generation: 11,
          base: 8,
          head: 'd'.repeat(64),
          wireMin: 5,
          backup: { id: 'backup-8', digest: DIGEST },
          stagedDigest: null,
        },
      })),
      readHousehold: vi.fn(),
    };
    await expect(
      new HttpOwnerSplitProvider(HOUSEHOLD, transport).lookup(ATTEMPT),
    ).resolves.toMatchObject({
      state: 'superseded',
      winner: { attempt: winnerAttempt, state: 'restored', wireMin: 5, stagedDigest: null },
    });
  });

  it('rejects noncanonical path identities before transport', async () => {
    const transport: OwnerSplitMigrationTransport = {
      request: vi.fn(),
      readHousehold: vi.fn(),
    };
    expect(() => new HttpOwnerSplitProvider('bad', transport)).toThrow();
    const provider = new HttpOwnerSplitProvider(HOUSEHOLD, transport);
    await expect(provider.lookup('../secret')).rejects.toThrow();
    expect(transport.request).not.toHaveBeenCalled();
  });

  describe('exclusive lock: an open answer always carries its bound backup', () => {
    const open = (purpose: 'split' | 'restore', backup: unknown) => ({
      state: 'open',
      attempt: ATTEMPT,
      purpose,
      wireMin: purpose === 'restore' ? 5 : 4,
      fence,
      ...(backup === undefined ? {} : { backup }),
    });
    const provider = (answer: unknown) =>
      new HttpOwnerSplitProvider(HOUSEHOLD, {
        request: vi.fn(async () => answer),
        readHousehold: vi.fn(),
      });

    it.each([
      ['a split open without a backup', open('split', undefined)],
      ['a restore open without a backup', open('restore', undefined)],
      ['a split bound to another attempt’s backup', open('split', { ...bound, attempt: ORIGINAL })],
      ['a restore bound to its own attempt’s backup', open('restore', bound)],
      ['a backup without its attempt', open('split', { id: 'backup-7', digest: DIGEST })],
      ['a backup with a malformed digest', open('split', { ...bound, digest: 'XYZ' })],
    ])('rejects %s', async (_name, answer) => {
      const purpose = answer.purpose as 'split' | 'restore';
      await expect(provider(answer).open(ATTEMPT, purpose, source)).rejects.toThrow(
        'invalid migration attempt evidence',
      );
      await expect(provider(answer).lookup(ATTEMPT)).rejects.toThrow(
        'invalid migration attempt evidence',
      );
    });

    it('accepts a handoff restore bound to the split’s backup, on open and on lookup alike', async () => {
      const answer = open('restore', { ...bound, attempt: ORIGINAL });
      const expected = { state: 'open', purpose: 'restore', backup: { attempt: ORIGINAL } };
      await expect(provider(answer).open(ATTEMPT, 'restore', source)).resolves.toMatchObject(
        expected,
      );
      await expect(provider(answer).lookup(ATTEMPT)).resolves.toMatchObject(expected);
    });

    it('does not require a backup on an aborted answer, which no longer carries a lock', async () => {
      await expect(
        provider({ ...open('split', undefined), state: 'aborted' }).lookup(ATTEMPT),
      ).resolves.toMatchObject({ state: 'aborted' });
    });
  });

  describe('exclusive lock: reading the bound backup', () => {
    const manifest = (attempt: string) => ({
      id: 'backup-7',
      digest: DIGEST,
      attempt,
      householdId: HOUSEHOLD,
      wireMin: 4,
      source: fence,
      authorization: { tokenHash: DIGEST, memberHash: null },
      rows: [],
    });

    it('reads through the restore attempt’s route and requires the split’s manifest', async () => {
      const request = vi.fn(async () => manifest(ORIGINAL));
      const provider = new HttpOwnerSplitProvider(HOUSEHOLD, { request, readHousehold: vi.fn() });
      await expect(provider.readBackup(ATTEMPT, ORIGINAL)).resolves.toMatchObject({
        attempt: ORIGINAL,
      });
      expect(request).toHaveBeenCalledWith({
        method: 'GET',
        path: `/lib/${HOUSEHOLD}/profile-migration/${ATTEMPT}/backup`,
      });
    });

    it('rejects a manifest that names a different attempt than the one it was bound to', async () => {
      const provider = new HttpOwnerSplitProvider(HOUSEHOLD, {
        request: vi.fn(async () => manifest(ORIGINAL)),
        readHousehold: vi.fn(),
      });
      await expect(provider.readBackup(ATTEMPT)).rejects.toThrow('invalid backup manifest');
    });

    it('has no way to create a backup', () => {
      const provider = new HttpOwnerSplitProvider(HOUSEHOLD, {
        request: vi.fn(),
        readHousehold: vi.fn(),
      });
      expect('createBackup' in provider).toBe(false);
    });
  });
});
