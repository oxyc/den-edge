import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(import.meta.dirname, '../../.github/workflows/ci.yml'),
  'utf8',
);

/** One top-level job's block: from its key to the next job's. */
function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  const next = workflow.slice(start + 1).search(/\n {2}[\w-]+:\n/);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

/** One step of a job block: from its name to the next step. */
function step(block: string, name: string): string {
  const start = block.indexOf(`name: ${name}`);
  expect(start, `step ${name}`).toBeGreaterThan(-1);
  const next = block.slice(start).search(/\n\s+- /);
  return next === -1 ? block.slice(start) : block.slice(start, start + next);
}

describe('TV CI independence', () => {
  it('enforces an executed isolation result without letting it hide the suites after it', () => {
    const checks = job('web-checks');
    const isolation = step(checks, 'TV isolation and bundle budgets');
    expect(isolation).toContain('id: tv_isolation');
    expect(isolation).toContain('continue-on-error: true');

    const gate = step(checks, 'Require TV isolation and bundle budgets');
    expect(gate).toContain("if: ${{ !cancelled() && steps.tv_isolation.outcome != 'skipped' }}");
    expect(gate).toContain('TV_ISOLATION: ${{ steps.tv_isolation.outcome }}');
    expect(gate).toContain('test "$TV_ISOLATION" = success');
    expect(checks.indexOf('name: Require TV isolation')).toBeGreaterThan(
      checks.indexOf('run: npm run test:e2e:tv-package'),
    );
  });

  it('reports both TV behavior paths on their own runner, apart from isolation, and the web gate requires them', () => {
    const tv = job('e2e_tv_chromium');
    expect(tv).not.toContain('tv_isolation');
    expect(tv).toContain('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: /usr/bin/google-chrome');
    expect(step(tv, 'LG/webOS TV behavior')).toContain('run: npm run test:e2e:tv');
    const tizen = step(tv, 'Supported Samsung/Tizen TV behavior');
    expect(tizen).toContain('if: ${{ !cancelled() }}');
    expect(tizen).toContain('run: DEN_TV_PLATFORM=tizen npm run test:e2e:tv -- tv-avplay.spec.mjs');

    const web = job('web');
    expect(web).toMatch(/needs: \[[^\]]*\be2e_tv_chromium\b/);
    expect(web).toContain('TV_CHROMIUM: ${{ needs.e2e_tv_chromium.result }}');
    expect(web).toContain('test "$TV_CHROMIUM" = success');
    expect(web).toContain('test "$TV_CHROMIUM" = skipped');
  });

  it('the web gate fails when any job it requires failed', () => {
    const gate = step(job('web'), 'Require every web check');
    const body = gate.slice(gate.indexOf('run: |') + 'run: |'.length);
    const lines = body.split('\n').filter((line) => line.trim());
    const indent = Math.min(...lines.map((line) => line.search(/\S/)));
    const script = lines.map((line) => line.slice(indent)).join('\n');
    const passing = {
      SOURCE_CHANGED: 'true',
      CHECKS: 'success',
      E2E: 'success',
      E2E_PRODUCTION: 'success',
      TV_CHROMIUM: 'success',
      TV_WEBKIT: 'success',
      ANDROID_TV: 'success',
      ANDROID_CHANGED: 'true',
    };
    // As the runner runs a `run:` step: `bash -e {0}`.
    const run = (env: Record<string, string>) =>
      spawnSync('bash', ['-e', '-c', script], { env: { PATH: process.env.PATH, ...env } }).status;
    expect(run(passing)).toBe(0);
    for (const name of [
      'CHECKS',
      'E2E',
      'E2E_PRODUCTION',
      'TV_CHROMIUM',
      'TV_WEBKIT',
      'ANDROID_TV',
    ])
      expect(run({ ...passing, [name]: 'failure' }), `${name} failed`).not.toBe(0);
  });
});
