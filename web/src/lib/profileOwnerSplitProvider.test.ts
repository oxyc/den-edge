import { describe, expect, it, vi } from 'vitest';
import {
  HttpOwnerSplitProvider,
  type OwnerSplitMigrationTransport,
} from './profileOwnerSplitProvider';

const HOUSEHOLD = '00112233445566778899aabbccddeeff';
const ATTEMPT = '0123456789abcdef0123456789abcdef';
const CANDIDATE = '11112222333344445555666677778888';
const DIGEST = 'a'.repeat(64);
const fence = { generation: 7, base: 4, head: DIGEST, rewrite: 'rewrite-7' };

describe('Owner split HTTP provider', () => {
  it('uses exact migration routes and never places credential material in a URL', async () => {
    const calls: unknown[] = [];
    const transport: OwnerSplitMigrationTransport = {
      request: vi.fn(async (input) => {
        calls.push(input);
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
        return { state: 'open', attempt: ATTEMPT, purpose: 'split', wireMin: 4, fence };
      }),
      readHousehold: vi.fn(async () => ({
        kind: 'legacy' as const,
        generation: 8,
        base: 5,
        head: 'b'.repeat(64),
      })),
    };
    const provider = new HttpOwnerSplitProvider(HOUSEHOLD, transport);
    await provider.open(ATTEMPT, 'split');
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
      {
        method: 'POST',
        path: `/lib/${HOUSEHOLD}/profile-migration`,
        body: { attempt: ATTEMPT, purpose: 'split' },
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
    const recovery = await provider.open(ATTEMPT, 'restore');
    expect(recovery).toMatchObject({ state: 'open', purpose: 'restore', wireMin: 5 });
    if (recovery.state !== 'open' || recovery.purpose !== 'restore') throw new Error('bad fixture');
    const restored = await provider.restore({
      attempt: recovery.attempt,
      backup: { attempt: 'f'.repeat(32), id: 'backup-7', digest: DIGEST },
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
});
