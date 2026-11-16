import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { addBoundaryRow, boundaryCounts, boundarySummary } from './boundaryDiagnostics';
import type { Row } from './wire';

describe('split-household boundary diagnostics', () => {
  it('reduces activity, settings, delivery, legacy and unreadable work to bounded counts', () => {
    const profile = '00112233445566778899aabbccddeeff';
    const rows = [
      { kind: 'title', title: { type: 'movie', id: 550 } },
      { kind: 'season', title: { type: 'tv', id: 1399 }, season: 2 },
      { kind: 'ep', title: { type: 'tv', id: 1399 }, season: 2, episode: 3 },
      {
        kind: 'set',
        name: `profile:${profile}`,
        values: { token: { value: { string: 'https://private.example/token' } } },
      },
      { kind: 'delivery', provider: 'simkl', account: 'secret-account' },
      { kind: 'wat', title: { type: 'movie', id: 680 } },
    ] as unknown as Row[];
    const counts = boundaryCounts();
    for (const row of rows) addBoundaryRow(counts, row);
    counts[3]++; // unreadable kept work

    const diagnostic = boundarySummary(counts);
    expect(diagnostic).toBe('activity=3, settings=1, delivery=1, unknown=2');
    for (const secret of [
      'title:movie:550',
      'season:tv:1399:2',
      'ep:tv:1399:2:3',
      'wat:movie:680',
      profile,
      'secret-account',
      'https://private.example/token',
    ])
      expect(diagnostic).not.toContain(secret);
  });

  it('keeps diagnostic size constant as refused work grows', () => {
    const counts = boundaryCounts();
    for (let index = 0; index < 10_000; index++)
      addBoundaryRow(counts, {
        kind: 'title',
        title: { type: 'movie', id: index + 1 },
      } as Row);

    expect(boundarySummary(counts)).toBe('activity=10000, settings=0, delivery=0, unknown=0');
  });

  it('keeps production profile transition call sites from forwarding names or caught causes', () => {
    const switcher = readFileSync(
      new URL('../components/ProfileSwitcher.svelte', import.meta.url),
      'utf8',
    );
    const ownerGate = readFileSync(
      new URL('../components/ProfileOwnerGate.svelte', import.meta.url),
      'utf8',
    );
    const routed = readFileSync(new URL('../RoutedLibrary.svelte', import.meta.url), 'utf8');
    const log = readFileSync(new URL('./log.ts', import.meta.url), 'utf8');

    const switchBody = switcher.match(/async function switchTo[\s\S]*?async function setPin/)?.[0];
    expect(switchBody).toContain('den: the ${choice.role} profile switch failed');
    expect(switchBody).toContain('den: the ${choice.role} profile switch was refused');
    expect(switchBody).not.toContain('choice.name');
    expect(switchBody).not.toContain('result.cause');
    expect(switcher).not.toMatch(/profile controls could not be loaded'\s*,/);
    expect(switcher).not.toMatch(/Owner PIN could not be saved'\s*,/);

    const ownerBody = ownerGate.match(/async function establishOwner[\s\S]*?<\/script>/)?.[0];
    expect(ownerBody).toContain('den: the owner profile switch failed');
    expect(ownerBody).not.toContain('result.cause');

    const staged = routed.match(/let kidAfterHousehold[\s\S]*?RENEW_EVERY_MS/)?.[0];
    expect(staged).toContain('den: the kid profile switch failed');
    expect(staged).toContain('den: the kid profile switch was refused');
    expect(staged).not.toContain('result.cause');
    expect(staged).not.toMatch(/console\.(?:warn|error)\([^\n]*,\s*error/);

    const rekey = log.match(/async rekeyKept[\s\S]*?async takeMoved/)?.[0];
    const recovery = log.match(/private async stageRecovery[\s\S]*?private holds/)?.[0];
    expect(rekey).not.toMatch(/console\.warn\([^;]*,\s*error/s);
    expect(recovery).not.toMatch(/console\.warn\([^;]*,\s*error/s);
  });
});
