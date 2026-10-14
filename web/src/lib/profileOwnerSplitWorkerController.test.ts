import { describe, expect, it, vi } from 'vitest';
import type {
  OwnerSplitHandoffRecovery,
  OwnerSplitJournal,
  OwnerSplitRunResult,
} from './profileOwnerSplitCoordinator';
import type { DormantOwnerSplitCoordinator } from './profileOwnerSplitCoordinator';
import { OwnerSplitWorkerController } from './profileOwnerSplitWorkerController';
import type { OwnerSplitWorkerSecureAdapter } from './profileOwnerSplitWorkerSecure';

const ATTEMPT = '0123456789abcdef0123456789abcdef';
const RECOVERY = 'fedcba9876543210fedcba9876543210';
const SOURCE = { generation: 7, head: 'a'.repeat(64) };

function fixture(
  journal: OwnerSplitJournal | null = null,
  options: {
    handoff?: OwnerSplitHandoffRecovery | null;
    locked?: boolean;
    resumed?: OwnerSplitRunResult;
  } = {},
) {
  const capability = vi.fn(async () => ({
    enrollment: 'prepare' as const,
    wireMin: 4,
    migrationWire: 5 as const,
    runtimeHouseholdWire: 5 as const,
    runtimeProfileWire: 4 as const,
  }));
  const loadJournal = vi.fn(async () => journal);
  const observeSource = vi.fn(async () => SOURCE);
  const prepare = vi.fn(async () => ({ kind: 'active' as const, attempt: ATTEMPT }));
  const resume = vi.fn(
    async (): Promise<OwnerSplitRunResult> => options.resumed ?? { kind: 'inactive' },
  );
  const authorizeRecovery = vi.fn(
    async (_attempt: string, _recoveryAttempt: string, _source: typeof SOURCE) => ({
      kind: 'restored' as const,
      attempt: ATTEMPT,
    }),
  );
  const recoverWithoutJournal = vi.fn(async (_recoveryAttempt: string, _source: typeof SOURCE) => ({
    kind: 'restored' as const,
    attempt: RECOVERY,
  }));
  const coordinator = {
    observeSource,
    prepare,
    resume,
    cancel: vi.fn(),
    authorizeRecovery,
    recoverWithoutJournal,
  } as unknown as DormantOwnerSplitCoordinator;
  const controller = new OwnerSplitWorkerController(
    {
      capability,
      loadJournal,
      loadHandoff: async () => options.handoff ?? null,
      migrationLocked: () => options.locked === true,
    },
    coordinator,
    {} as OwnerSplitWorkerSecureAdapter,
  );
  return {
    controller,
    observeSource,
    prepare,
    resume,
    authorizeRecovery,
    recoverWithoutJournal,
  };
}

describe('Owner split Worker controller', () => {
  it('reports availability without minting, observing, or starting an attempt', async () => {
    const value = fixture();
    await expect(value.controller.status()).resolves.toEqual({ phase: 'available' });
    expect(value.observeSource).not.toHaveBeenCalled();
    expect(value.prepare).not.toHaveBeenCalled();
    expect(value.resume).not.toHaveBeenCalled();
  });

  it('reports a committed wire-5 household as enabled without minting an attempt', async () => {
    const value = fixture();
    const capability = vi.fn(async () => ({
      enrollment: 'off' as const,
      wireMin: 5,
      migrationWire: 5 as const,
      runtimeHouseholdWire: 5 as const,
      runtimeProfileWire: 4 as const,
    }));
    const controller = new OwnerSplitWorkerController(
      {
        capability,
        loadJournal: async () => null,
        loadHandoff: async () => null,
        migrationLocked: () => false,
      },
      {
        observeSource: value.observeSource,
        resume: value.resume,
      } as unknown as DormantOwnerSplitCoordinator,
      {} as OwnerSplitWorkerSecureAdapter,
    );
    await expect(controller.status()).resolves.toEqual({ phase: 'enabled' });
    expect(value.observeSource).not.toHaveBeenCalled();
    expect(value.resume).not.toHaveBeenCalled();
  });

  it('observes before PIN and passes only that exact source into the explicit enable action', async () => {
    const value = fixture();
    const observation = await value.controller.observe();
    expect(observation.source).toEqual(SOURCE);
    await value.controller.enable(observation.attempt, observation.source);
    expect(value.prepare).toHaveBeenCalledWith(observation.attempt, SOURCE);
  });

  it('resumes only when a durable exact attempt already exists', async () => {
    const journal = {
      version: 6,
      attempt: ATTEMPT,
      explicitIntent: true,
      householdId: 'b'.repeat(32),
      source: SOURCE,
      splitAuthorization: {
        intent: {
          version: 1,
          action: 'enable-profiles',
          attempt: ATTEMPT,
          householdId: 'b'.repeat(32),
          source: SOURCE,
        },
        intentDigest: 'c'.repeat(64),
        commitBinding: null,
      },
      state: 'idle',
    } satisfies OwnerSplitJournal;
    const value = fixture(journal);
    await expect(value.controller.status()).resolves.toEqual({
      phase: 'preparing',
      attempt: ATTEMPT,
    });
    expect(value.resume).toHaveBeenCalledOnce();
    expect(value.observeSource).not.toHaveBeenCalled();
  });

  it('uses a separate explicit recovery action rather than reusing split consent', async () => {
    const journal = {
      version: 6,
      attempt: ATTEMPT,
      explicitIntent: true,
      householdId: 'b'.repeat(32),
      source: SOURCE,
      splitAuthorization: {
        intent: {
          version: 1,
          action: 'enable-profiles',
          attempt: ATTEMPT,
          householdId: 'b'.repeat(32),
          source: SOURCE,
        },
        intentDigest: 'c'.repeat(64),
        commitBinding: null,
      },
      state: 'restore-required',
      fence: { generation: 7, base: 4, head: SOURCE.head, rewrite: 'rewrite-7' },
      backup: { id: 'backup-7', digest: 'd'.repeat(64) },
    } satisfies OwnerSplitJournal;
    const value = fixture(journal);
    const recovery = await value.controller.observeRecovery(ATTEMPT);
    expect(recovery.source).toEqual(SOURCE);
    expect(recovery.recoveryAttempt).toMatch(/^[0-9a-f]{32}$/);
    await value.controller.recover(ATTEMPT, recovery.recoveryAttempt, recovery.source);
    expect(value.authorizeRecovery).toHaveBeenCalledOnce();
    expect(value.authorizeRecovery.mock.calls[0]?.[0]).toBe(ATTEMPT);
    expect(value.authorizeRecovery.mock.calls[0]?.[1]).toBe(recovery.recoveryAttempt);
    expect(value.authorizeRecovery.mock.calls[0]?.[2]).toEqual(SOURCE);
  });

  describe('exclusive migration lock', () => {
    it('reports another device’s lock only after an ordinary write bounced off it', async () => {
      await expect(fixture(null, { locked: true }).controller.status()).resolves.toEqual({
        phase: 'setup-in-progress',
      });
      await expect(fixture(null, { locked: false }).controller.status()).resolves.toEqual({
        phase: 'available',
      });
    });

    it('offers the journal-less Restore only for a household known to be locked', async () => {
      const locked = fixture(null, { locked: true });
      const recovery = await locked.controller.observeRecovery(null);
      expect(recovery).toMatchObject({ attempt: null, source: SOURCE });
      expect(recovery.recoveryAttempt).toMatch(/^[0-9a-f]{32}$/);
      await locked.controller.recover(null, recovery.recoveryAttempt, recovery.source);
      expect(locked.recoverWithoutJournal).toHaveBeenCalledWith(recovery.recoveryAttempt, SOURCE);
      expect(locked.authorizeRecovery).not.toHaveBeenCalled();

      const idle = fixture(null, { locked: false });
      await expect(idle.controller.observeRecovery(null)).rejects.toThrow('not required');
      expect(idle.observeSource).not.toHaveBeenCalled();
    });

    it('keeps the durable handoff’s attempt and source when Restore is offered again', async () => {
      const handoff = { version: 1 as const, recoveryAttempt: RECOVERY, source: SOURCE };
      const value = fixture(null, { handoff });
      await expect(value.controller.observeRecovery(null)).resolves.toEqual({
        attempt: null,
        recoveryAttempt: RECOVERY,
        source: SOURCE,
      });
      expect(value.observeSource).not.toHaveBeenCalled();
    });

    it('resumes a durable handoff on status and reports what it came to', async () => {
      const handoff = { version: 1 as const, recoveryAttempt: RECOVERY, source: SOURCE };
      const restored = fixture(null, {
        handoff,
        resumed: { kind: 'restored', attempt: RECOVERY },
      });
      await expect(restored.controller.status()).resolves.toEqual({ phase: 'enabled' });
      expect(restored.resume).toHaveBeenCalledOnce();

      const blocked = fixture(null, {
        handoff,
        resumed: { kind: 'recovery-blocked', attempt: RECOVERY },
      });
      await expect(blocked.controller.status()).resolves.toEqual({ phase: 'recovery-required' });
    });

    it('logs a failed handoff resume and still offers Restore instead of hiding it as unavailable', async () => {
      const handoff = { version: 1 as const, recoveryAttempt: RECOVERY, source: SOURCE };
      const value = fixture(null, { handoff });
      value.resume.mockRejectedValueOnce(new Error('invalid_state'));
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(value.controller.status()).resolves.toEqual({ phase: 'recovery-required' });
        expect(log).toHaveBeenCalledWith(expect.stringContaining('recovery'), expect.any(Error));
      } finally {
        log.mockRestore();
      }
    });

    it('does not start a split beside a durable handoff', async () => {
      const handoff = { version: 1 as const, recoveryAttempt: RECOVERY, source: SOURCE };
      const value = fixture(null, { handoff });
      await expect(value.controller.observe()).rejects.toThrow('already durable');
    });
  });
});
