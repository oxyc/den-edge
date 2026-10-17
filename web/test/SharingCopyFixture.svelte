<!-- Minimal host for Settings › Sharing. Its mix of lendable, bare and combined installs also pins which plugins a
     new invite may escrow without a real den-edge behind it. -->
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
  // Scout and Atlas are lendable; bare Reel has no settings to escrow. Hearth stays installed separately: the grant
  // protocol carries legacy service configs and Edge derives the guest's stable Hearth overlay from them.
  const routes = Object.fromEntries(
    ['scout', 'atlas', 'reel', 'subs', 'den'].map((addon) => [
      addon,
      [{ url: `${location.origin}/${addon === 'subs' ? 'subtitles' : addon}` }],
    ]),
  );
  const plugins = [
    `${location.origin}/scout/testcfg123/manifest.json`,
    `${location.origin}/atlas/atlascfg456/manifest.json`,
    `${location.origin}/reel/manifest.json`,
    `${location.origin}/den/hearthcfg789/manifest.json`,
    'https://plugins.example/foreign/manifest.json',
  ];
</script>

<main style="padding:24px; max-width:420px">
  <SharingSection {link} {model} {plugins} {routes} ready={true} />
</main>
