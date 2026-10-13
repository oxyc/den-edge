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
        return { state: 'open', attempt: ATTEMPT, fence };
      }),
      readHousehold: vi.fn(async () => ({
        kind: 'legacy' as const,
        generation: 8,
        base: 5,
        head: 'b'.repeat(64),
      })),
    };
    const provider = new HttpOwnerSplitProvider(HOUSEHOLD, transport);
    expect('stage' in provider).toBe(false);
    expect('commit' in provider).toBe(false);
    await provider.open(ATTEMPT, 'split');
    await provider.lookup(ATTEMPT);
    await provider.abort(ATTEMPT);
    await provider.retireCandidate({
      attempt: ATTEMPT,
      source: fence,
      authority: { kind: 'legacy', generation: 8, base: 5, head: 'b'.repeat(64) },
      candidate: {
        profileId: HOUSEHOLD,
        libraryId: CANDIDATE,
        keyRef: 'secure-slot',
        keyFingerprint: DIGEST,
      },
      protectedLibraryIds: [HOUSEHOLD],
    });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: `/lib/${HOUSEHOLD}/profile-migration`,
        body: { attempt: ATTEMPT, purpose: 'split' },
      },
      { method: 'GET', path: `/lib/${HOUSEHOLD}/profile-migration/${ATTEMPT}`, body: undefined },
      { method: 'DELETE', path: `/lib/${HOUSEHOLD}/profile-migration/${ATTEMPT}`, body: undefined },
      expect.objectContaining({
        method: 'POST',
        path: `/lib/${HOUSEHOLD}/profile-migration/${ATTEMPT}/retire-candidate`,
        candidateKeyRef: 'secure-slot',
      }),
    ]);
    expect(JSON.stringify(calls)).not.toContain('libraryKey');
    expect(JSON.stringify(calls)).not.toContain('candidateToken');
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
