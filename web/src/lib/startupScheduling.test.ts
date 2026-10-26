import { describe, expect, it } from 'vitest';
import { scheduleAfterStartupMilestone } from './startupScheduling';

describe('startup milestone scheduling', () => {
  it('admits work after any useful milestone and the requested quiet delay', () => {
    let now = 0;
    const milestones = new Set<string>();
    const scheduled: Array<{ task: () => void; after: number }> = [];
    const ran: number[] = [];
    scheduleAfterStartupMilestone(
      () => ran.push(now),
      ['first poster', 'billboard detail'],
      {},
      (event) => (milestones.has(event) ? now : undefined),
      () => now,
      (task, after) => scheduled.push({ task, after }),
    );

    now = 250;
    scheduled.shift()!.task();
    expect(ran).toEqual([]);
    milestones.add('billboard detail');
    now = 500;
    scheduled.shift()!.task();
    const admitted = scheduled.shift()!;
    expect(admitted.after).toBe(1_000);
    now += admitted.after;
    admitted.task();
    expect(ran).toEqual([1_500]);
  });

  it('admits an empty surface after a bounded wait', () => {
    let now = 0;
    const scheduled: Array<{ task: () => void; after: number }> = [];
    let ran = false;
    scheduleAfterStartupMilestone(
      () => (ran = true),
      ['never'],
      { timeoutMs: 500, delayMs: 0, pollMs: 250 },
      () => undefined,
      () => now,
      (task, after) => scheduled.push({ task, after }),
    );
    while (!ran) {
      const next = scheduled.shift()!;
      now += next.after;
      next.task();
    }
    expect(now).toBe(500);
  });
});
