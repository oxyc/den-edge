import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('split-household boundary diagnostics', () => {
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
    expect(switchBody).toContain("'den: profile switch', choice.role, result.outcome");
    expect(switchBody).not.toContain('choice.name');
    expect(switchBody).not.toContain('result.cause');
    expect(switcher).not.toMatch(/profile controls could not be loaded'\s*,/);
    expect(switcher).not.toMatch(/Owner PIN could not be saved'\s*,/);

    const ownerBody = ownerGate.match(/async function establishOwner[\s\S]*?<\/script>/)?.[0];
    expect(ownerBody).toContain("'den: profile switch', 'owner', result.outcome");
    expect(ownerBody).not.toContain('result.cause');

    const staged = routed.match(/let kidAfterHousehold[\s\S]*?RENEW_EVERY_MS/)?.[0];
    expect(staged).toContain("'den: profile switch', 'kid', result.outcome");
    expect(staged).not.toContain('result.cause');
    expect(staged).not.toMatch(/console\.(?:warn|error)\([^\n]*,\s*error/);
    expect(routed).not.toMatch(/profile key reset could not (?:start|continue)'\s*,/);
    expect(routed).not.toMatch(/guest library could not be started'\s*,/);

    const rekey = log.match(/async rekeyKept[\s\S]*?async takeMoved/)?.[0];
    const recovery = log.match(/private async stageRecovery[\s\S]*?private holds/)?.[0];
    expect(rekey).not.toMatch(/console\.warn\([^;]*,\s*error/s);
    expect(recovery).not.toMatch(/console\.warn\([^;]*,\s*error/s);
  });

  it('shows no playback-receipt failure (a Try again that cannot succeed) while the library is missing', () => {
    const routed = readFileSync(new URL('../RoutedLibrary.svelte', import.meta.url), 'utf8');
    // Both renderers (the lazy status and the eager fallback) sit behind the missing-library branch.
    const block = routed.match(/\{#if shown\.missingLibrary\}[\s\S]*?\{\/if\}\s*\{\/if\}/)?.[0];
    expect(block).toContain('{:else if PlaybackReceiptStatus');
    expect(block).toContain('alertRetry={() => playbackReceiptRetry++}');
    // Receipts are set up again once a read finds the log.
    expect(routed).toMatch(/void session\.missingLibrary;/);
  });
});
