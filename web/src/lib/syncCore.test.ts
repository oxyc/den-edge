import { describe, expect, it } from 'vitest';
import fixtures from '../vendor/den-core/policy-v1.json';
import profileFixtures from '../vendor/den-core/profiles-v1.json';
import { inPolicySlices, syncPolicy } from './syncCore';
import { assistantPolicy, ensureAssistantPolicy } from './assistantCore';
import { ensureRecoveryPolicy, recoveryPolicy } from './recoveryCore';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import manifest from '../vendor/den-core/SOURCE.json';

describe('shared Rust WASM sync policy', () => {
  it('yields after a bounded amount of staged synchronous work', async () => {
    let now = 0;
    let yields = 0;
    const seen: number[] = [];
    await inPolicySlices(
      [1, 2, 3, 4, 5],
      (value) => {
        seen.push(value);
        now += 2;
      },
      {
        budgetMs: 4,
        now: () => now,
        yieldTask: async () => {
          yields++;
        },
      },
    );
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(yields).toBe(2);
  });

  it('stops staged work when its owner is replaced during a yield', async () => {
    let now = 0;
    let live = true;
    const seen: number[] = [];
    const completed = await inPolicySlices(
      [1, 2, 3, 4],
      (value) => {
        seen.push(value);
        now += 2;
      },
      {
        budgetMs: 4,
        now: () => now,
        shouldContinue: () => live,
        yieldTask: async () => {
          live = false;
        },
      },
    );
    expect(completed).toBe(false);
    expect(seen).toEqual([1, 2]);
  });

  it('vendored artifacts match their source-pinned manifest', () => {
    expect(manifest.sourceDigest).toHaveLength(64);
    for (const [path, expected] of Object.entries(manifest.artifacts)) {
      const bytes = readFileSync(new URL(`../vendor/den-core/${path}`, import.meta.url));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
    }
  });
  // The assistant ops are a module of their own, which the main one refuses as `assistant_module`.
  const assistantOp = (request: Record<string, unknown>) =>
    String(request.op).startsWith('assistant_');
  // recovery_derive is the one case that is not a few microseconds of policy: the den-spec vector is a real
  // Argon2id at 64 MiB (the cost is the point of the code, and a weaker vector would not be the contract), about
  // 0.3 s on an idle machine and memory-bandwidth bound, so it slows far more than the rest when runners share a
  // machine. It gets a budget sized for that instead of the 5 s default.
  const kdfOps = new Set(['recovery_derive']);
  const persistentProfileCases = profileFixtures.cases.filter(
    ({ request }) =>
      !String(request.op).startsWith('profiles_migration_') && request.op !== 'profiles_capability',
  );
  for (const test of [...fixtures.cases, ...persistentProfileCases]) {
    it(
      test.name,
      async () => {
        const recoveryOp = kdfOps.has(String(test.request.op));
        const policy = assistantOp(test.request)
          ? assistantPolicy
          : recoveryOp
            ? recoveryPolicy
            : syncPolicy;
        if (assistantOp(test.request)) await ensureAssistantPolicy();
        if (recoveryOp) await ensureRecoveryPolicy();
        if ('error' in test) expect(() => policy(test.request)).toThrow(test.error);
        else expect(policy(test.request)).toEqual(test.ok);
      },
      kdfOps.has(String(test.request.op)) ? 30_000 : undefined,
    );
  }

  it('the main module refuses an assistant op, naming the module that has it', () => {
    expect(() => syncPolicy({ op: 'assistant_grant_key', random: '00'.repeat(32) })).toThrow(
      'assistant_module',
    );
  });

  it('the main module does not carry the memory-hard recovery operation', () => {
    expect(() => syncPolicy({ op: 'recovery_derive', data: 'A'.repeat(22) })).toThrow(
      'invalid_request',
    );
  });
});
