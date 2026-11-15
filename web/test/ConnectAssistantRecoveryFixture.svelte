<script lang="ts">
  import { onDestroy } from 'svelte';
  import ConnectDialog from '../src/components/ConnectDialog.svelte';
  import {
    assistantLibrary,
    type AssistantLibraryAuthority,
  } from '../src/lib/assistantLibrary.svelte';
  import type { LibraryModel } from '../src/lib/libraryModel.svelte';
  import '../src/app.css';

  const query = new URLSearchParams(location.search);
  let releaseConsent = () => {};
  let releaseCleanup = () => {};
  const consentGate = query.has('hold-consent')
    ? new Promise<void>((resolve) => (releaseConsent = resolve))
    : Promise.resolve();
  const cleanupGate = query.has('hold-cleanup')
    ? new Promise<void>((resolve) => (releaseCleanup = resolve))
    : Promise.resolve();
  const calls = { consent: 0, revoke: 0, readback: 0 };
  const firstModel = {
    async consentAssistant() {
      calls.consent++;
      await consentGate;
      return {
        grant: '11111111111111111111111111111111',
        key: 'fixture-write-key',
      };
    },
    async revokeAssistant() {
      calls.revoke++;
      await cleanupGate;
      return 'revoked' as const;
    },
    async assistantRevocationReadback() {
      calls.readback++;
      return 'revoked' as const;
    },
  } as unknown as LibraryModel;
  const replacementModel = {
    async consentAssistant() {
      return {
        grant: '22222222222222222222222222222222',
        key: 'replacement-write-key',
      };
    },
    async revokeAssistant() {
      return 'revoked' as const;
    },
    async assistantRevocationReadback() {
      return 'revoked' as const;
    },
  } as unknown as LibraryModel;
  const memberFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('x-den-library-member', 'fixture:member');
    return fetch(input, { ...init, headers });
  };
  const first: AssistantLibraryAuthority = { model: firstModel, fetch: memberFetch };
  const replacement: AssistantLibraryAuthority = { model: replacementModel, fetch: memberFetch };
  assistantLibrary.authority = first;
  const controls = {
    calls: () => ({ ...calls }),
    replace: () => (assistantLibrary.authority = replacement),
    releaseConsent,
    releaseCleanup,
  };
  (
    globalThis as typeof globalThis & {
      assistantRecoveryFixture?: typeof controls;
    }
  ).assistantRecoveryFixture = controls;
  onDestroy(() => {
    if (assistantLibrary.authority === first || assistantLibrary.authority === replacement)
      assistantLibrary.authority = null;
  });
</script>

<ConnectDialog />
