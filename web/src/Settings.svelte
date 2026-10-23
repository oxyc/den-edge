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
  import { flushSync, onDestroy } from 'svelte';
  import type { Link } from './lib/links.svelte';
  import { ATLAS_FALLBACK, mergeCredits, readAttribution, type Credit } from './settings/credits';
  import { householdAssistantFetch, relayFetch } from './lib/relayFetch';
  import {
    findAddon,
    findAtlas,
    legacyMediaSuperseded,
    migrateLegacyMedia,
    REEL,
    type Addon,
  } from './lib/scout';
  import { fetchRoutes, type Routes } from './lib/routes';
  import { untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import type { LibraryModel } from './lib/libraryModel.svelte';
  import type { KeyResetOutcome } from './lib/libraryServiceProtocol';
  import type { JoinLibrary } from './lib/browserHousehold';
  import type { ProfilePreferences } from './lib/profilePreferences.svelte';
  import type { ContentServiceClientPort } from './lib/contentServiceClient';
  import Button from './components/Button.svelte';
  import { keyboardInput } from './lib/inputModality';

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
    preferences = null,
  }: {
    link: Link | null;
    model: LibraryModel;
    /**
     * The active profile's own preferences. Once the household has split, `model` is the household's control log, which
     * holds no preferences; all of them (region and services included) are in the profile's library, so they are read
     * from and written to here. Null while the household has no profiles.
     */
    preferences?: ProfilePreferences | null;
    content: ContentServiceClientPort;
    local?: boolean;
    /** Present where this browser's own library or household can be brought into another. */
    onjoin?: JoinLibrary;
    onresetkey?: () => Promise<KeyResetOutcome | null>;
    heldReset?: boolean;
    onadoptheld?: () => Promise<void>;
  } = $props();

  let connectionsLease = $state.raw(untrack(() => model.connections()));
  const simklLease = untrack(() => model.simkl());
  const recoveryLease = untrack(() => (__DEN_TV_LEGACY_JS_CORE__ ? undefined : model.recovery()));
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
  const effectivePreferences = $derived(preferences ? preferences.value : settings?.preferences);
  const ready = $derived(!!settings && !!effectivePreferences && !!connections);
  const loadError = $derived(model.settings.error ?? connectionsLease.snapshot.error);
  let retrying = $state(false);
  let failure = $state<string | null>(null);
  let saving = $state(false);
  /** Tells Den's own plugins apart, so they're listed by name rather than by a LAN address. */
  let routes = $state.raw<Routes>({});
  /** Whether /routes has answered (or failed): until then an install on another of the deployment's names is unplaced. */
  let routesLoaded = $state(false);
  void fetchRoutes().then((fetched) => {
    routes = fetched;
    routesLoaded = true;
  });
  let edgeVersion = $state<string | null>(null);
  const viewerSections = ['connections', 'advanced'] as const;
  void fetch('/version')
    .then((res) => (res.ok ? (res.json() as Promise<{ version?: unknown }>) : null))
    .then((body) => {
      if (typeof body?.version === 'string') edgeVersion = body.version;
    })
    .catch(() => undefined);

  const prefs = $derived(effectivePreferences ? structuredClone(effectivePreferences) : undefined);
  // Undefined means the encrypted Settings view is still opening. It is never presented as an empty plugin list.
  const plugins = $derived(connections ? structuredClone(connections.plugins) : undefined);
  const pluginUrls = $derived(plugins?.map((plugin) => plugin.manifestUrl) ?? []);
  const disabled = $derived(!ready || saving);
  const libraryFormat = $derived(connections?.diagnostics.libraryFormat ?? null);
  const profileTopology = $derived(connections?.diagnostics.profileTopology ?? false);
  /** One add-first migration probe per settled plugin view; a changed view (including TV approval) tries again. */
  let hearthMigrationAttempt = '';

  async function run(action: () => Promise<unknown>, quiet = false): Promise<boolean> {
    const restoreFocus =
      document.activeElement instanceof HTMLElement &&
      (__DEN_TV__ || keyboardInput() || document.activeElement.matches(':focus-visible'))
        ? document.activeElement
        : undefined;
    // Disabling a native control during its save can make some WebKit versions choose another focusable element
    // instead of the document body. Distinguish that engine-driven move from a viewer who deliberately moved on
    // while the request was pending, so completion never steals focus back from fresh input.
    let movedOn = false;
    let watchingNewInput = false;
    const noteInput = () => {
      if (watchingNewInput) movedOn = true;
    };
    if (restoreFocus) {
      document.addEventListener('keydown', noteInput, { capture: true });
      document.addEventListener('pointerdown', noteInput, { capture: true });
      // A spatial-navigation handler can synchronously click a switch while its initiating keydown is still being
      // dispatched at document. That key is the edit, not evidence that the viewer moved on after it.
      queueMicrotask(() => (watchingNewInput = true));
    }
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
      // Commit the enabled controls and any preference publication in this task. If this waits for `tick`, a TV
      // remote can observe the newly enabled surface, move to its next control, and then have the continuation below
      // steal focus back to the setting that just saved.
      flushSync(() => {
        if (!quiet) saving = false;
      });
      // Saving temporarily disables the settings surface. Some engines move focus to the document when the active
      // native control becomes disabled, which strands the next keyboard/remote press. Return keyboard users to that
      // same connected control once the save settles, without reopening a phone keyboard after a pointer save.
      if (restoreFocus) {
        document.removeEventListener('keydown', noteInput, { capture: true });
        document.removeEventListener('pointerdown', noteInput, { capture: true });
        // TV Settings is intentionally inert during a save; a remote press cannot make a reliable move until it
        // settles, so always return to its semantic origin. Pointer/keyboard web users may deliberately move on.
        if (
          (__DEN_TV__ || !movedOn) &&
          restoreFocus.isConnected &&
          !restoreFocus.matches(':disabled')
        )
          restoreFocus.focus({ preventScroll: true });
      }
    }
  }

  async function patchPreferences(changes: PreferenceChanges): Promise<void> {
    if (!preferences) {
      await model.patchPreferences(changes);
      return;
    }
    // Every preference, region and services included, belongs to the active profile's library; the household's write
    // guard would drop one sent to the control log. Only the maturity ceiling is not a profile preference (a
    // profile's policy lives in the directory) and stays on the control log.
    const { maturityCeiling, ...personal } = changes;
    if ('maturityCeiling' in changes) await model.patchPreferences({ maturityCeiling });
    if (Object.keys(personal).length) await preferences.patch(personal);
  }
  const savePrefs = (changes: PreferenceChanges) => void run(() => patchPreferences(changes));
  const removeLibraryDevice = (id: string) => run(() => model.removeDevice(id));

  // What Den's own addons credit, read from their manifests (den-spec attribution-v1). A browser asks only Den's own
  // addons anything; den-atlas's statements stand in while its manifest can't be read or doesn't name them yet, since
  // its rows and the billboard show that data regardless.
  let addonCredits = $state.raw<Credit[][]>([[...ATLAS_FALLBACK]]);
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

  // Installing Hearth is deliberately add-first. A plugin another device adds stays pending on the TV, so it is
  // excluded here until every TV has approved it. Only then, and only after its live manifest proves the configured
  // resource exists, retire that resource's legacy addon. Atlas is not part of this migration.
  $effect(() => {
    if (!ready || !Object.keys(routes).length) return;
    const approved = plugins!
      .filter((plugin) => plugin.pendingApprovalOn.length === 0)
      .map((plugin) => plugin.manifestUrl);
    const attempt = JSON.stringify([approved, routes]);
    if (attempt === hearthMigrationAttempt) return;
    hearthMigrationAttempt = attempt;
    let cancelled = false;
    void migrateLegacyMedia(approved, routes).then(async (manifestUrl) => {
      if (cancelled) return;
      if (manifestUrl) {
        await run(() => model.installPlugin(manifestUrl), true);
        return; // wait for the changed plugin view, and every TV's approval, before cleanup
      }
      const legacy = await legacyMediaSuperseded(approved, routes);
      for (const url of legacy) {
        if (cancelled || !(await run(() => model.removePlugin(url), true))) return;
      }
    });
    return () => {
      cancelled = true;
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

  // den-edge's assistant connections are asked about as `model`'s member. On a household split into profiles that is
  // the household, whose connections they are (profiles-v1 §6.1), while the page's own credential may be Owner's.
  const assistantConnectionFetch = __DEN_TV_LEGACY_JS_CORE__
    ? Promise.resolve(undefined)
    : untrack(() => model.ready.then(() => model.relayMembership())).then(
        (membership) => (membership ? householdAssistantFetch(membership) : undefined),
        (error: unknown) => {
          console.error('den: the library’s assistant membership could not be read', error);
          return undefined;
        },
      );

  const hasRecoveryCode = $derived(!!recoveryView?.live);
  const selfId = $derived(connections?.diagnostics.selfDeviceId ?? '');

  async function sealHandover(
    handoverKey: string,
    host: string,
    linkKey: string,
    grantTicket?: string,
  ) {
    const { result } = await model.sealPairingHandover(handoverKey, host, linkKey, grantTicket);
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
</script>

<div class="settings">
  <SettingsNav variant="rail" sections={__DEN_TV_LEGACY_JS_CORE__ ? viewerSections : undefined} />
  <div class="page">
    <div class="title">
      <h1>Settings</h1>
      <ExpandAll label="Settings" />
    </div>
    <SettingsNav variant="bar" sections={__DEN_TV_LEGACY_JS_CORE__ ? viewerSections : undefined} />
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
      {#if !__DEN_TV_LEGACY_JS_CORE__}
        <PlaybackSection prefs={prefs!} {disabled} save={savePrefs} />
        <ContentSection
          prefs={prefs!}
          {content}
          pinConfigured={connections?.parentalPinConfigured ?? false}
          {disabled}
          save={savePrefs}
          savePin={(pin) => run(() => model.setParentalPin(pin))}
          verifyPin={(pin) => model.verifyParentalPin(pin)}
          pinRemovable={!profileTopology}
        />
      {/if}
      <ConnectionsSection
        {link}
        {content}
        {onjoin}
        onresetkey={link && libraryFormat !== null && libraryFormat >= 4 && !profileTopology
          ? onresetkey
          : undefined}
        profileResetBlocked={!!link && profileTopology}
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
        viewerOnly={__DEN_TV_LEGACY_JS_CORE__}
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
      {#if !__DEN_TV_LEGACY_JS_CORE__}
        <SharingSection
          {link}
          {model}
          plugins={pluginUrls}
          {routes}
          ready={ready && routesLoaded}
          {sealHandover}
          {selfId}
        />
        <AssistantsSection
          connectionFetch={assistantConnectionFetch}
          revokeGrant={link && !local ? (grant) => model.revokeAssistant(grant) : undefined}
          listGrants={link && !local ? () => model.assistantGrants() : undefined}
        />
        <ImportSection
          {ready}
          {content}
          watched={model.overview.value?.watched ?? []}
          {importHistory}
          {exportHistory}
        />
      {/if}
      <AdvancedSection
        {link}
        onjoin={local && onjoin
          ? async (key: string) => (await onjoin(key)) === 'joined'
          : undefined}
        recovery={link && !local ? recovery : undefined}
        remoteAccessConfigured={connections?.remoteAccessConfigured ?? false}
        {disabled}
        {selfId}
        pendingActions={connections?.diagnostics.pendingChanges ?? 0}
        {edgeVersion}
        {libraryFormat}
        setRemoteAccess={(credentials) => run(() => model.setRemoteAccess(credentials))}
        viewerOnly={__DEN_TV_LEGACY_JS_CORE__}
      />
    {/if}
    {#if !__DEN_TV_LEGACY_JS_CORE__}<AboutSection credits={mergeCredits(addonCredits)} />{/if}
  </div>
</div>

<style>
  .settings {
    display: grid;
    grid-template-columns: var(--settings-columns, 220px minmax(0, 760px));
    justify-content: center;
    gap: var(--settings-column-gap, 56px);
    font-size: var(--settings-font-size, inherit);
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
    font-size: var(--settings-title-size, 28px);
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
    font-size: var(--settings-font-size, 14px);
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
    min-height: var(--settings-field-min-height, 44px);
    padding: 10px 14px;
    border: 1px solid transparent;
    border-radius: 10px;
    background: rgb(255 255 255 / 0.06);
    color: var(--fg);
    font: inherit;
    font-size: var(--settings-font-size, 16px);
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
    font-size: var(--settings-font-size, 14px);
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
    font-size: var(--settings-font-size, 14px);
  }

  .settings :global(.status) {
    margin: 10px 0 0;
    color: var(--muted);
    font-size: var(--settings-font-size, 14px);
  }

  .settings :global(.status.bad) {
    color: var(--danger);
  }

  .settings :global(.foot) {
    margin: 10px 0 0;
    color: var(--muted);
    font-size: var(--settings-caption-size, 13px);
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
    font-size: var(--settings-caption-size, 13px);
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
