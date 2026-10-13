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
  const bindings = new Map<string, string>();
  const store = new OwnerSplitWorkerStore({
    libraryId: HOUSEHOLD,
    keepRequired: async (name: string, value: unknown, binding = '') => {
      values.set(name, structuredClone(value));
      bindings.set(name, binding);
    },
    keptRequired: async <T>(name: string, binding = '') => {
      const value = values.get(name);
      if (value === undefined) return { kind: 'absent' as const };
      if (bindings.get(name) !== binding) throw new Error('Encrypted migration state is corrupt');
      return { kind: 'value' as const, value: value as T };
    },
    discardKept: async (name) => {
      values.delete(name);
      bindings.delete(name);
    },
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

  it('allows only the exact authenticated source observation route without candidate authority', async () => {
    const { transport, request } = harness(200, {
      source: { generation: 7, head: 'a'.repeat(64) },
    });
    await expect(
      transport.request({
        method: 'GET',
        path: `/lib/${HOUSEHOLD}/profile-migration/source`,
      }),
    ).resolves.toEqual({ source: { generation: 7, head: 'a'.repeat(64) } });
    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      path: `/lib/${HOUSEHOLD}/profile-migration/source`,
    });
    expect(request.mock.calls[0]![0]).not.toHaveProperty('candidateToken');
    await expect(
      transport.request({
        method: 'POST',
        path: `/lib/${HOUSEHOLD}/profile-migration/source`,
      }),
    ).rejects.toThrow(/not allowed/);
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
    ).rejects.toThrow(/not allowed/);
    await expect(
      transport.request({
        method: 'POST',
        path: `/lib/${HOUSEHOLD}/profile-migration/${'b'.repeat(32)}/retire-candidate`,
        candidateKeyRef: candidate.keyRef,
      }),
    ).rejects.toThrow(/corrupt/);
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects suffix, query, dot-segment, method confusion and candidate-token leakage', async () => {
    const { transport, store, request } = harness();
    const candidate = await store.allocateCandidate(ATTEMPT);
    const retire = `/lib/${HOUSEHOLD}/profile-migration/${ATTEMPT}/retire-candidate`;
    for (const input of [
      { method: 'GET' as const, path: retire, candidateKeyRef: candidate.keyRef },
      { method: 'POST' as const, path: `${retire}/extra`, candidateKeyRef: candidate.keyRef },
      { method: 'POST' as const, path: `${retire}?x=1`, candidateKeyRef: candidate.keyRef },
      {
        method: 'POST' as const,
        path: `/lib/${HOUSEHOLD}/profile-migration/${ATTEMPT}/../${ATTEMPT}/retire-candidate`,
        candidateKeyRef: candidate.keyRef,
      },
      {
        method: 'POST' as const,
        path: `/lib/${HOUSEHOLD}/profile-migration/${ATTEMPT}/rows`,
        candidateKeyRef: candidate.keyRef,
      },
    ])
      await expect(transport.request(input)).rejects.toThrow();
    await expect(transport.request({ method: 'POST', path: retire })).rejects.toThrow(
      /requires Worker-owned authority/,
    );
    expect(request).not.toHaveBeenCalled();
  });
});
