<!-- Minimal host for SharingSection (Settings › Sharing), for an e2e repro/regression test of its iOS Safari
     copy-button bug: a bare library credential and one hosted Scout install are enough to reach the "Copy
     link"/"Copy code" buttons without a real den-edge behind it. -->
<script lang="ts">
  import SharingSection from '../src/settings/SharingSection.svelte';
  import { useLibraryCredential } from '../src/lib/relayFetch';
  import type { Link } from '../src/lib/links.svelte';
  import type { LibraryModel } from '../src/lib/libraryModel.svelte';
  import '../src/app.css';

  const membership = { libraryId: 'f'.repeat(32), memberToken: 'proof' };
  // Profile mode has a different global Owner credential. Sharing must deliberately use the household model below.
  useLibraryCredential({ id: 'e'.repeat(32), member: 'owner-proof' });
  const model = {
    relayMembership: async () => {
      if (new URLSearchParams(location.search).has('membership-fails'))
        throw new Error('fixture membership failure');
      return membership;
    },
  } as LibraryModel;

  const link: Link = {
    inboxKey: 'deadbeefcafe1234',
    name: 'Living Room TV',
    libraryKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    linkKey: 'fixture',
  };
  // A Scout install this origin's own route table has no entry for, so `place()` guesses the config
  // segment from the URL itself — the same path a real household's public-name install takes.
  const plugins = [`${location.origin}/scout/testcfg123/manifest.json`];
</script>

<main style="padding:24px; max-width:420px">
  <SharingSection {link} {model} {plugins} routes={{}} ready={true} />
</main>
