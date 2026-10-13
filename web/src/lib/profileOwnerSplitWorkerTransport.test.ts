import { describe, expect, it, vi } from 'vitest';
import { OwnerSplitWorkerStore } from './profileOwnerSplitWorkerStore';
import {
  OwnerSplitWorkerTransport,
  type OwnerSplitWorkerNetwork,
} from './profileOwnerSplitWorkerTransport';

const HOUSEHOLD = '1'.repeat(32);
const ATTEMPT = 'a'.repeat(32);

function harness(status = 200, body: unknown = { ok: true }) {
  const values = new Map<string, unknown>();
  const store = new OwnerSplitWorkerStore({
    libraryId: HOUSEHOLD,
    keepRequired: async (name: string, value: unknown) =>
      void values.set(name, structuredClone(value)),
    kept: async <T>(name: string) => values.get(name) as T | undefined,
    discardKept: async (name) => void values.delete(name),
  });
  const request = vi.fn(
    async (_input: Parameters<OwnerSplitWorkerNetwork['profileMigrationRequest']>[0]) => ({
      status,
      body,
    }),
  );
  const network: OwnerSplitWorkerNetwork = {
    libraryId: HOUSEHOLD,
    profileMigrationRequest: request,
    readProfileMigrationHousehold: vi.fn(async () => ({
      kind: 'legacy' as const,
      generation: 0,
      base: 1,
      head: 'd'.repeat(64),
    })),
  };
  return { store, request, transport: new OwnerSplitWorkerTransport(network, store) };
}

describe('OwnerSplit Worker authenticated transport', () => {
  it('reads and strictly validates the per-household capability', async () => {
    const capability = {
      enrollment: 'prepare',
      wireMin: 4,
      migrationWire: 5,
      runtimeHouseholdWire: 5,
      runtimeProfileWire: 4,
    } as const;
    const { transport, request } = harness(200, capability);
    await expect(transport.capability()).resolves.toEqual(capability);
    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      path: `/lib/${HOUSEHOLD}/profile-capability`,
    });
    await expect(harness(404, { error: 'not_found' }).transport.capability()).resolves.toBeNull();
    await expect(
      harness(200, { ...capability, migrationWire: 4 }).transport.capability(),
    ).rejects.toThrow(/malformed/);
  });

  it('resolves a candidate token only inside the Worker and never adds it to path or body', async () => {
    const { transport, store, request } = harness();
    const candidate = await store.allocateCandidate(ATTEMPT);
    await transport.request({
      method: 'POST',
      path: `/lib/${HOUSEHOLD}/profile-migration/${ATTEMPT}/retire-candidate`,
      body: { candidateLibraryId: candidate.libraryId },
      candidateKeyRef: candidate.keyRef,
    });
    const sent = request.mock.calls[0]![0];
    expect(sent.candidateToken).toMatch(/^[0-9a-f]{64}$/);
    expect(sent.path).not.toContain(sent.candidateToken);
    expect(JSON.stringify(sent.body)).not.toContain(sent.candidateToken);
  });

  it('rejects cross-household paths and attempt replay before network IO', async () => {
    const { transport, store, request } = harness();
    const candidate = await store.allocateCandidate(ATTEMPT);
    await expect(
      transport.request({ method: 'GET', path: `/lib/${'2'.repeat(32)}/profile-migration` }),
    ).rejects.toThrow(/outside/);
    await expect(
      transport.request({
        method: 'POST',
        path: `/lib/${HOUSEHOLD}/profile-migration/${'b'.repeat(32)}/retire-candidate`,
        candidateKeyRef: candidate.keyRef,
      }),
    ).rejects.toThrow(/not bound/);
    expect(request).not.toHaveBeenCalled();
  });
});
