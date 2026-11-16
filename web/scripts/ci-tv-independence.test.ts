import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(import.meta.dirname, '../../.github/workflows/ci.yml'),
  'utf8',
);

describe('TV CI independence', () => {
  it('reports both TV behavior paths before enforcing an executed isolation result', () => {
    const isolation = workflow.indexOf('name: TV isolation and bundle budgets');
    const webos = workflow.indexOf('name: LG/webOS TV behavior', isolation);
    const tizen = workflow.indexOf('name: Supported Samsung/Tizen TV behavior', webos);
    const gate = workflow.indexOf('name: Require TV isolation and bundle budgets', tizen);

    expect(isolation).toBeGreaterThan(-1);
    expect(webos).toBeGreaterThan(isolation);
    expect(tizen).toBeGreaterThan(webos);
    expect(gate).toBeGreaterThan(tizen);

    const isolationStep = workflow.slice(isolation, webos);
    expect(isolationStep).toContain('id: tv_isolation');
    expect(isolationStep).toContain('continue-on-error: true');

    const behaviorCondition = "if: ${{ !cancelled() && steps.tv_isolation.outcome != 'skipped' }}";
    const webosStep = workflow.slice(webos, tizen);
    expect(webosStep).toContain(behaviorCondition);
    expect(webosStep).toContain('run: npm run test:e2e:tv');
    const tizenStep = workflow.slice(tizen, gate);
    expect(tizenStep).toContain(behaviorCondition);
    expect(tizenStep).toContain(
      'run: DEN_TV_PLATFORM=tizen npm run test:e2e:tv -- tv-avplay.spec.mjs',
    );

    const gateStep = workflow.slice(gate, workflow.indexOf('- name:', gate + 1));
    expect(gateStep).toContain(behaviorCondition);
    expect(gateStep).toContain('TV_ISOLATION: ${{ steps.tv_isolation.outcome }}');
    expect(gateStep).toContain('test "$TV_ISOLATION" = success');
  });
});
