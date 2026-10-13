import { describe, expect, it } from 'vitest';
import fixtures from '../vendor/den-core/policy-v1.json';
import profileFixtures from '../vendor/den-core/profiles-v1.json';
import { inPolicySlices, syncPolicy } from './syncCore';
import { assistantPolicy, ensureAssistantPolicy } from './assistantCore';
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
  for (const test of [...fixtures.cases, ...profileFixtures.cases]) {
    it(test.name, async () => {
      const policy = assistantOp(test.request) ? assistantPolicy : syncPolicy;
      if (assistantOp(test.request)) await ensureAssistantPolicy();
      if ('error' in test) expect(() => policy(test.request)).toThrow(test.error);
      else expect(policy(test.request)).toEqual(test.ok);
    });
  }

  it('fails closed when profile migration planner evidence is missing or malformed', () => {
    const fence = { generation: 7, head: 'a'.repeat(64) };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ state: 'fenced', observed: 'legacy', fence }, 'invalid_migration_fence'],
      [
        {
          state: 'fenced',
          observed: 'legacy',
          fence,
          observedFence: { generation: -1, head: 'a'.repeat(64) },
        },
        'invalid_migration_fence',
      ],
      [{ state: 'adopting', observed: 'committed' }, 'committed_directory_missing'],
      [
        {
          state: 'owner-copied',
          observed: 'legacy',
          fence,
          observedFence: fence,
          backupVerified: true,
          candidateKey: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=',
          ownerVerified: true,
        },
        'invalid_copy_head',
      ],
    ];
    for (const [input, error] of cases)
      expect(() => syncPolicy({ op: 'profiles_migration_next', input })).toThrow(error);
  });

  it('the main module refuses an assistant op, naming the module that has it', () => {
    expect(() => syncPolicy({ op: 'assistant_grant_key', random: '00'.repeat(32) })).toThrow(
      'assistant_module',
    );
  });
});
