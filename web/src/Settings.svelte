<!-- Settings, as on the TV. Typed views and semantic commands keep storage inside the library service. -->
<script lang="ts">
  import AboutSection from './settings/AboutSection.svelte';
  import AssistantsSection from './settings/AssistantsSection.svelte';
  import ExpandAll from './settings/ExpandAll.svelte';
  import AdvancedSection from './settings/AdvancedSection.svelte';
  import ConnectionsSection from './settings/ConnectionsSection.svelte';
  import ContentSection from './settings/ContentSection.svelte';
  import ImportSection from './settings/ImportSection.svelte';
  import PlaybackSection from './settings/PlaybackSection.svelte';
  import RecoveryCode from './settings/RecoveryCode.svelte';
  import SettingsNav from './settings/SettingsNav.svelte';
  import SharingSection from './settings/SharingSection.svelte';
  import type { PreferenceChanges } from './settings/preferences';
  import { thisDevice } from './lib/device.svelte';
  import { onDestroy } from 'svelte';
  import type { Link } from './lib/links.svelte';
  import { ATLAS_FALLBACK, mergeCredits, readAttribution, type Credit } from './settings/credits';
  import { relayFetch } from './lib/relayFetch';
  import { findAddon, findAtlas, REEL, type Addon } from './lib/scout';
  import { fetchRoutes, type Routes } from './lib/routes';
  import { untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import type { LibraryModel } from './lib/libraryModel.svelte';
  import type { KeyResetOutcome } from './lib/libraryServiceProtocol';
  import type { ContentServiceClientPort } from './lib/contentServiceClient';
  import Button from './components/Button.svelte';

  /** `link` is null for a browser using its own library (`session.local`), with no TV linked yet. */
  let {
    link,
    model,
    content,
    local = false,
    onjoin,
    onresetkey,
    heldReset = false,
    onadoptheld,
  }: {
    link: Link | null;
    model: LibraryModel;
    content: ContentServiceClientPort;
    local?: boolean;
    onjoin?: (libraryKey: string) => Promise<boolean>;
    onresetkey?: () => Promise<KeyResetOutcome | null>;
    heldReset?: boolean;
    onadoptheld?: () => Promise<void>;
  } = $props();

  let connectionsLease = $state.raw(untrack(() => model.connections()));
  const simklLease = untrack(() => model.simkl());
  const recoveryLease = untrack(() => model.recovery());
  onDestroy(() => {
    connectionsLease?.release();
    simklLease?.release();
    recoveryLease?.release();
  });
  const settings = $derived(model.settings.value);
  const connections = $derived(connectionsLease?.snapshot.value);
  const simkl = $derived(simklLease?.snapshot.value);
  const recoveryView = $derived(
    recoveryLease?.snapshot.value ? structuredClone(recoveryLease.snapshot.value) : undefined,
  );
  const ready = $derived(!!settings && !!connections);
  const loadError = $derived(model.settings.error ?? connectionsLease.snapshot.error);
  let retrying = $state(false);
  let failure = $state<string | null>(null);
  let saving = $state(false);
  /** Tells Den's own plugins apart, so they're listed by name rather than by a LAN address. */
  let routes = $state<Routes>({});
  void fetchRoutes().then((fetched) => (routes = fetched));
  let edgeVersion = $state<string | null>(null);
  void fetch('/version')
    .then((res) => (res.ok ? (res.json() as Promise<{ version?: unknown }>) : null))
    .then((body) => {
      if (typeof body?.version === 'string') edgeVersion = body.version;
    })
    .catch(() => undefined);

  const prefs = $derived(settings ? structuredClone(settings.preferences) : undefined);
  // Undefined means the encrypted Settings view is still opening. It is never presented as an empty plugin list.
  const plugins = $derived(connections ? structuredClone(connections.plugins) : undefined);
  const pluginUrls = $derived(plugins?.map((plugin) => plugin.manifestUrl) ?? []);
  const disabled = $derived(!ready || saving);
  const libraryFormat = $derived(connections?.diagnostics.libraryFormat ?? null);

  async function run(action: () => Promise<unknown>, quiet = false): Promise<boolean> {
    if (!quiet) {
      saving = true;
      failure = null;
    }
    try {
      await action();
      return true;
    } catch (error) {
      console.warn('den: settings command failed', error);
      if (!quiet) failure = 'Couldn’t save that. Check your connection and try again.';
      return false;
    } finally {
      if (!quiet) saving = false;
    }
  }

  const savePrefs = (changes: PreferenceChanges) => void run(() => model.patchPreferences(changes));
  const removeLibraryDevice = (id: string) => run(() => model.removeDevice(id));

  // What Den's own addons credit, read from their manifests (den-spec attribution-v1). A browser asks only Den's own
  // addons anything; den-atlas's statements stand in while its manifest can't be read or doesn't name them yet, since
  // its rows and the billboard show that data regardless.
  let addonCredits = $state<Credit[][]>([[...ATLAS_FALLBACK]]);
  $effect(() => {
    if (!ready) return;
    const installed = pluginUrls;
    const table = routes;
    let gone = false;
    const creditsOf = async (addon: Addon | null): Promise<Credit[] | null> => {
      if (!addon) return null;
      try {
        const res = await relayFetch(`${addon.base}/manifest.json`);
        return res.ok ? readAttribution(await res.json()) : null;
      } catch {
        return null;
      }
    };
    void Promise.all([
      findAtlas(installed, table).then(creditsOf),
      findAddon(installed, table, REEL).then(creditsOf),
    ]).then(([atlas, reel]) => {
      if (!gone) addonCredits = [atlas?.length ? atlas : [...ATLAS_FALLBACK], reel ?? []];
    });
    return () => {
      gone = true;
    };
  });

  async function retryLoad() {
    if (retrying) return;
    retrying = true;
    try {
      if (model.connection === 'failed') await model.retry();
      else if (connectionsLease.snapshot.error) {
        connectionsLease.release();
        connectionsLease = model.connections();
      }
    } catch {
      // The model snapshots keep the exact retryable failure and this surface stays available for another try.
    } finally {
      retrying = false;
    }
  }

  async function saveSimkl(token: string | null): Promise<boolean> {
    return run(() => (token ? model.connectSimkl(token) : model.disconnectSimkl()));
  }

  const heldRemovals = $derived(simkl?.heldRemovals ?? []);

  /**
   * Their names, from TMDB through den-edge's proxy as the library names any title it holds no display for: a
   * removed title's display is gone with it. One that can't be looked up is shown by its id.
   */
  const heldNames = new SvelteMap<string, string>();
  $effect(() => {
    const held = heldRemovals;
    // The names untracked: one arriving must not re-run this and drop the lookups still on their way.
    const wanted = untrack(() => held.filter((ref) => !heldNames.has(`${ref.type}:${ref.id}`)));
    if (!wanted.length) return;
    const ask = new AbortController();
    void content
      .query({ kind: 'titles', titles: wanted }, ask.signal)
      .then((answer) => {
        if (ask.signal.aborted) return;
        for (const found of answer.titles) heldNames.set(`${found.type}:${found.id}`, found.title);
      })
      .catch(() => undefined);
    return () => ask.abort();
  });
  const namedRemovals = $derived(
    heldRemovals.map((ref) => ({ ...ref, name: heldNames.get(`${ref.type}:${ref.id}`) })),
  );

  /**
   * Approve exactly the removals shown: the latest stamp among them, by compare-and-set on the account's delivery
   * row, which counts for every device. False when the row changed meanwhile; the list is read and shown again.
   */
  async function approveRemovals(): Promise<boolean> {
    const approvalId = simkl?.approvalId;
    return !!approvalId && run(() => model.approveSimklRemovals(approvalId));
  }

  const hasRecoveryCode = $derived(!!recoveryView?.live);
  const selfId = $derived(connections?.diagnostics.selfDeviceId ?? '');

  async function sealHandover(handoverKey: string, host: string, linkKey: string) {
    const { result } = await model.sealPairingHandover(handoverKey, host, linkKey);
    if (result.kind !== 'pairing.handover') throw new Error('wrong pairing response');
    return result;
  }

  async function sealRecovery(locator: string, wrapKey: string, createdAt: number) {
    const { result } = await model.sealRecovery(locator, wrapKey, createdAt);
    if (result.kind !== 'recovery.seal') throw new Error('wrong recovery response');
    return result.sealed;
  }

  async function recoveryOutcome(
    action: () => ReturnType<LibraryModel['beginRecovery']>,
  ): Promise<string> {
    const { result } = await action();
    return 'outcome' in result ? result.outcome : 'failed';
  }

  async function importHistory(items: Parameters<LibraryModel['importHistory']>[0]) {
    const { result } = await model.importHistory(items);
    if (result.kind !== 'history.import') throw new Error('wrong history import response');
    return result;
  }

  async function exportHistory() {
    const { result } = await model.exportHistory();
    if (result.kind !== 'history.export') throw new Error('wrong history export response');
    return result;
  }

  // This browser lists itself among the devices with the library, as each device does when it opens it: again when its
  // name changes, and otherwise at most once a day.
  $effect(() => {
    if (!ready) return;
    const name = thisDevice.name;
    const timer = setTimeout(() => void run(() => model.heartbeatDevice(name), true), 1000);
    return () => clearTimeout(timer);
  });
</script>

<div class="settings">
  <SettingsNav variant="rail" />
  <div class="page">
    <div class="title">
      <h1>Settings</h1>
      <ExpandAll label="Settings" />
    </div>
    <SettingsNav variant="bar" />
    {#if failure}<p class="banner bad" role="alert">{failure}</p>{/if}
    {#if !ready}
      <div
        class:bad={!!loadError}
        class="banner settings-load"
        role={loadError ? 'alert' : 'status'}
      >
        <p>{loadError ? 'Couldn’t load your settings.' : 'Loading your settings…'}</p>
        {#if loadError}
          <Button
            variant="secondary"
            icon="retry"
            label={retrying ? 'Trying again…' : 'Try again'}
            disabled={retrying}
            onclick={() => void retryLoad()}
          />
        {/if}
      </div>
    {:else}
      <PlaybackSection prefs={prefs!} {disabled} save={savePrefs} />
      <ContentSection
        prefs={prefs!}
        {content}
        pinConfigured={connections?.parentalPinConfigured ?? false}
        {disabled}
        save={savePrefs}
        savePin={(pin) => run(() => model.setParentalPin(pin))}
        verifyPin={(pin) => model.verifyParentalPin(pin)}
      />
      <ConnectionsSection
        {link}
        {content}
        onjoin={local ? onjoin : undefined}
        onresetkey={link && libraryFormat !== null && libraryFormat >= 4 ? onresetkey : undefined}
        {hasRecoveryCode}
        {heldReset}
        {onadoptheld}
        apiKeys={connections!.apiKeys}
        simklConnected={!!simkl?.connected}
        {saveSimkl}
        heldRemovals={namedRemovals}
        {approveRemovals}
        plugins={plugins!}
        {routes}
        servers={structuredClone(connections!.servers)}
        devices={structuredClone(connections!.devices)}
        {selfId}
        {disabled}
        setApiKey={(service, value) => run(() => model.setApiKey(service, value))}
        installPlugin={(url) => run(() => model.installPlugin(url))}
        removePlugin={(url) => run(() => model.removePlugin(url))}
        setPluginTrust={(url, key) => run(() => model.setPluginTrust(url, key))}
        removeServer={(server) => run(() => model.patchServer(server, null))}
        {sealHandover}
        removeDevice={removeLibraryDevice}
        recovery={link && !local ? recovery : undefined}
      />
      {#snippet recovery()}
        <RecoveryCode
          view={recoveryView}
          {ready}
          seal={sealRecovery}
          begin={(locator, sealed, createdAt) =>
            recoveryOutcome(() => model.beginRecovery(locator, sealed, createdAt))}
          confirm={(locator) => recoveryOutcome(() => model.confirmRecovery(locator))}
          abandon={async (locator) => {
            await model.abandonRecovery(locator);
          }}
          disable={async () => run(() => model.disableRecovery())}
        />
      {/snippet}
      <SharingSection {link} plugins={pluginUrls} {routes} {ready} />
      <AssistantsSection />
      <ImportSection
        {ready}
        {content}
        watched={model.overview.value?.watched ?? []}
        {importHistory}
        {exportHistory}
      />
      <AdvancedSection
        remoteAccessConfigured={connections?.remoteAccessConfigured ?? false}
        {disabled}
        {selfId}
        pendingActions={connections?.diagnostics.pendingChanges ?? 0}
        {edgeVersion}
        {libraryFormat}
        setRemoteAccess={(credentials) => run(() => model.setRemoteAccess(credentials))}
      />
    {/if}
    <AboutSection credits={mergeCredits(addonCredits)} />
  </div>
</div>

<style>
  .settings {
    display: grid;
    grid-template-columns: 220px minmax(0, 760px);
    justify-content: center;
    gap: 56px;
  }

  .page {
    min-width: 0;
  }

  .title {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin: 8px 0 20px;
  }

  h1 {
    margin: 0;
    font-size: 28px;
  }

  .banner {
    margin: 0 0 20px;
    padding: 12px 16px;
    border-radius: 12px;
    background: var(--card);
    color: var(--muted);
  }

  .banner.bad {
    color: var(--danger);
  }

  .settings-load {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  .settings-load p {
    margin: 0;
  }

  @media (width < 1100px) {
    .settings {
      grid-template-columns: minmax(0, 720px);
    }

    .settings > :global(.rail) {
      display: none;
    }
  }

  /* What every row's panel is made of: fields, buttons, lists, status lines and footers. */
  .settings :global(.panel h3) {
    margin: 18px 0 8px;
    color: var(--muted);
    font-size: 14px;
    font-weight: 600;
  }

  .settings :global(.form) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin-top: 12px;
  }

  .settings :global(.field) {
    flex: 1 1 240px;
    width: 100%;
    min-width: 0;
    min-height: 44px;
    padding: 10px 14px;
    border: 1px solid transparent;
    border-radius: 10px;
    background: rgb(255 255 255 / 0.06);
    color: var(--fg);
    font: inherit;
    font-size: 16px;
  }

  .settings :global(.field::placeholder) {
    color: var(--muted);
  }

  .settings :global(.field:focus) {
    border-color: var(--accent);
    outline: none;
  }

  .settings :global(.mono) {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  .settings :global(.link-button) {
    margin-left: auto;
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }

  .settings :global(.summary) {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 12px;
    margin: 14px 0 4px;
    color: var(--muted);
    font-size: 14px;
  }

  .settings :global(.status) {
    margin: 10px 0 0;
    color: var(--muted);
    font-size: 14px;
  }

  .settings :global(.status.bad) {
    color: var(--danger);
  }

  .settings :global(.foot) {
    margin: 10px 0 0;
    color: var(--muted);
    font-size: 13px;
  }

  .settings :global(.list) {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .settings :global(.line) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    padding: 12px 0;
    border-top: 1px solid var(--line);
  }

  .settings :global(.line:first-child) {
    border-top: 0;
  }

  .settings :global(.line .label) {
    flex: 1 1 220px;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .settings :global(.line .label small) {
    display: block;
    color: var(--muted);
    font-size: 13px;
  }

  .settings :global(.actions) {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  /* A link inside a sentence reads as the sentence does, marked by its underline; the TV draws no blue text, and the
     accent stays for controls. Only prose links: the section rail's links have their own look. */
  .settings :global(p a) {
    color: inherit;
    text-decoration: underline;
    text-decoration-color: rgb(255 255 255 / 0.35);
    text-underline-offset: 0.15em;
  }

  .settings :global(p a:hover) {
    color: var(--fg);
    text-decoration-color: currentcolor;
  }

  @media (width < 760px) {
    .settings :global(.form .den-button) {
      flex: 1 1 auto;
    }
  }
</style>
