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
  import SettingRow from './settings/SettingRow.svelte';
  import SettingsSection from './settings/SettingsSection.svelte';
  import SharingSection from './settings/SharingSection.svelte';
  import type { PreferenceChanges } from './settings/preferences';
  import { flushSync, onDestroy } from 'svelte';
  import type { Link } from './lib/links.svelte';
  import {
    AIRING_CREDIT,
    ATLAS_FALLBACK,
    mergeCredits,
    readAttribution,
    type Credit,
  } from './settings/credits';
  import { householdAssistantFetch, relayFetch } from './lib/relayFetch';
  import { findAddon, findAtlas, REEL, type Addon } from './lib/scout';
  import { fetchRoutes, type Routes } from './lib/routes';
  import { untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import type { LibraryModel } from './lib/libraryModel.svelte';
  import { LibraryServiceError } from './lib/libraryServiceClient';
  import type { KeyResetOutcome } from './lib/libraryServiceProtocol';
  import type { CompoundResetStartResult } from './lib/profileKeyResetPage';
  import type { JoinLibrary } from './lib/browserHousehold';
  import type { ProfilePreferences } from './lib/profilePreferences.svelte';
  import type { ContentServiceClientPort } from './lib/contentServiceClient';
  import Button from './components/Button.svelte';
  import { keyboardInput } from './lib/inputModality';
  import { i18n } from './lib/i18n.svelte';
  import {
    readLocalInterfaceLanguage,
    rememberLocalInterfaceLanguage,
    type InterfaceLanguage,
  } from './lib/interfaceLanguage';
  import { rememberFreshPresentationLanguage } from './lib/translationCache';
  import { LibraryJoinPresentationOwner } from './lib/libraryJoinPresentation';

  /** `link` is null for a browser using its own library (`session.local`), with no TV linked yet. */
  let {
    link,
    model,
    activityModel = model,
    content,
    local = false,
    onjoin,
    onresetkey,
    oncompoundreset,
    compoundResetPending = false,
    heldReset = false,
    onadoptheld,
    oninterfacelanguage,
    preferences = null,
  }: {
    link: Link | null;
    model: LibraryModel;
    /** The active Owner activity library; household administration remains on `model`. */
    activityModel?: LibraryModel;
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
    oncompoundreset?: (pin: string) => Promise<CompoundResetStartResult>;
    compoundResetPending?: boolean;
    heldReset?: boolean;
    onadoptheld?: () => Promise<void>;
    oninterfacelanguage?: (language: InterfaceLanguage) => void;
  } = $props();

  type SettingsAuthority = {
    /** Household control authority: devices, credentials shared by the household, recovery and Owner PIN. */
    model: LibraryModel;
    /** Exact active Owner activity authority: tracker credentials, commands and delivery review. */
    activityModel: LibraryModel;
    /** Exact active profile preference writer; null means the household settings log owns preferences. */
    preferences: ProfilePreferences | null;
    connections: ReturnType<LibraryModel['connections']>;
    simkl?: ReturnType<LibraryModel['simkl']>;
    recovery?: ReturnType<LibraryModel['recovery']>;
  };
  const acquireAuthority = (
    household: LibraryModel,
    activity: LibraryModel,
    profilePreferences: ProfilePreferences | null,
  ): SettingsAuthority => ({
    model: household,
    activityModel: activity,
    preferences: profilePreferences,
    connections: household.connections(),
    ...(!__DEN_TV_LEGACY_JS_CORE__
      ? { simkl: activity.simkl(), recovery: household.recovery() }
      : {}),
  });
  const releaseAuthority = (authority: SettingsAuthority) =>
    [authority.connections, authority.simkl, authority.recovery].forEach((lease) =>
      lease?.release(),
    );
  const joinPresentation = new LibraryJoinPresentationOwner();
  let authority = $state.raw(untrack(() => acquireAuthority(model, activityModel, preferences)));
  let authorityGeneration = 0;
  let retrying = $state(false);
  let failure = $state<string | null>(null);
  let saving = $state(false);
  // A retained Settings page can receive either a replacement household or a replacement Owner activity library.
  // Publish the complete replacement bundle before DOM reconciliation and before retiring every old lease, so a
  // ready replacement keeps retained sections mounted while tracker presentation and commands can never fall back
  // to the household control log or remain attached to the previous profile generation.
  $effect.pre(() => {
    const replacementHousehold = model;
    const replacementActivity = activityModel;
    const replacementPreferences = preferences;
    joinPresentation.replace(replacementHousehold);
    if (
      authority.model === replacementHousehold &&
      authority.activityModel === replacementActivity &&
      authority.preferences === replacementPreferences
    )
      return;
    const previous = authority;
    authority = untrack(() =>
      acquireAuthority(replacementHousehold, replacementActivity, replacementPreferences),
    );
    authorityGeneration++;
    retrying = false;
    failure = null;
    saving = false;
    releaseAuthority(previous);
  });
  onDestroy(() => {
    joinPresentation.invalidate();
    releaseAuthority(authority);
  });
  const settings = $derived(authority.model.settings.value);
  const connections = $derived(authority.connections.snapshot.value);
  const simkl = $derived(authority.simkl?.snapshot.value);
  const recoveryView = $derived.by(() => {
    const view = authority.recovery?.snapshot.value;
    return view ? structuredClone(view) : undefined;
  });
  const exactAuthority = $derived(
    authority.model === model &&
      authority.activityModel === activityModel &&
      authority.preferences === preferences,
  );
  const ownsAuthority = (owner: SettingsAuthority, generation: number): boolean =>
    generation === authorityGeneration &&
    authority === owner &&
    owner.model === model &&
    owner.activityModel === activityModel &&
    owner.preferences === preferences;
  const effectivePreferences = $derived(
    authority.preferences ? authority.preferences.value : settings?.preferences,
  );
  let localInterfaceLanguage = $state(
    untrack(() => (local ? readLocalInterfaceLanguage() : undefined)),
  );
  const loadError = $derived(
    authority.model.settings.error ??
      authority.preferences?.policy.settings.error ??
      authority.connections.snapshot.error ??
      authority.simkl?.snapshot.error,
  );
  // Keep a complete presentation mounted across a ready-to-ready authority swap. Props invalidate exactAuthority
  // before the pre-effect can publish the replacement bundle; using exactAuthority as the block's mount condition
  // would therefore destroy and recreate every section for that internal handoff. Commands and controls still use
  // exact `ready`, so the old presentation cannot act during that boundary. An actually opening or failed replacement
  // has no complete presentation and remains withheld.
  const authorityLoaded = $derived(
    !!settings &&
      !!effectivePreferences &&
      !!connections &&
      (__DEN_TV_LEGACY_JS_CORE__ || !!simkl) &&
      !loadError,
  );
  // A failed selector may retain its previous value for diagnosis, but that stale authority must not keep Settings
  // actionable or hide the retry control while a fresh binding is required.
  const ready = $derived(exactAuthority && authorityLoaded);
  /** Tells Den's own plugins apart, so they're listed by name rather than by a LAN address. */
  let routes = $state.raw<Routes>({});
  /** Whether /routes has answered (or failed): until then an install on another of the deployment's names is unplaced. */
  let routesLoaded = $state(false);
  void fetchRoutes().then((fetched) => {
    routes = fetched;
    routesLoaded = true;
  });
  let edgeVersion = $state<string | null>(null);
  const viewerSections = ['content', 'connections', 'sharing', 'assistants', 'advanced'] as const;
  void fetch('/version')
    .then((res) => (res.ok ? (res.json() as Promise<{ version?: unknown }>) : null))
    .then((body) => {
      if (typeof body?.version === 'string') edgeVersion = body.version;
    })
    .catch(() => undefined);

  const prefs = $derived.by(() => {
    if (!effectivePreferences) return undefined;
    const value = structuredClone(effectivePreferences);
    return local
      ? { ...value, interfaceLanguage: localInterfaceLanguage ?? value.interfaceLanguage }
      : { ...value, interfaceLanguage: i18n.language };
  });
  // Undefined means the encrypted Settings view is still opening. It is never presented as an empty plugin list.
  const plugins = $derived(connections ? structuredClone(connections.plugins) : undefined);
  const pluginUrls = $derived(plugins?.map((plugin) => plugin.manifestUrl) ?? []);
  const disabled = $derived(!ready || saving);
  const libraryFormat = $derived(connections?.diagnostics.libraryFormat ?? null);
  const profileTopology = $derived(connections?.diagnostics.profileTopology ?? false);
  const profileTopologyBlocked = $derived(connections?.diagnostics.profileTopologyBlocked ?? false);
  // Wire 5 is profile-aware even when its directory is missing or unreadable. Treating that recovery state as a
  // legacy household would expose the one-library destructive reset that profiles-v1 explicitly forbids.
  const profileAware = $derived(
    profileTopology || profileTopologyBlocked || (connections?.diagnostics.libraryFormat ?? 0) >= 5,
  );
  async function run(action: () => Promise<unknown>, quiet = false): Promise<boolean> {
    const owner = authority;
    const generation = authorityGeneration;
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
      if (!quiet && ownsAuthority(owner, generation))
        failure = 'Couldn’t save that. Check your connection and try again.';
      return false;
    } finally {
      // Commit the enabled controls and any preference publication in this task. If this waits for `tick`, a TV
      // remote can observe the newly enabled surface, move to its next control, and then have the continuation below
      // steal focus back to the setting that just saved.
      flushSync(() => {
        if (!quiet && ownsAuthority(owner, generation)) saving = false;
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
          ownsAuthority(owner, generation) &&
          (__DEN_TV__ || !movedOn) &&
          restoreFocus.isConnected &&
          !restoreFocus.matches(':disabled')
        )
          restoreFocus.focus({ preventScroll: true });
      }
    }
  }

  async function patchPreferences(changes: PreferenceChanges): Promise<void> {
    const owner = authority;
    const generation = authorityGeneration;
    const profilePreferences = owner.preferences;
    const publishInterfaceLanguage = oninterfacelanguage;
    const localPresentation = local;
    const publishLanguage = (language: InterfaceLanguage) => {
      if (
        !ownsAuthority(owner, generation) ||
        publishInterfaceLanguage !== oninterfacelanguage ||
        localPresentation !== local
      )
        return;
      rememberFreshPresentationLanguage(language);
      if (localPresentation) {
        localInterfaceLanguage = language;
        rememberLocalInterfaceLanguage(language);
      }
      publishInterfaceLanguage?.(language);
    };
    if (!profilePreferences) {
      const language = changes.interfaceLanguage;
      await owner.model.patchPreferences(changes);
      if (language) publishLanguage(language);
      return;
    }
    // Every preference, region and services included, belongs to the active profile's library; the household's write
    // guard would drop one sent to the control log. Only the maturity ceiling is not a profile preference (a
    // profile's policy lives in the directory) and stays on the control log.
    const { maturityCeiling, ...personal } = changes;
    if ('maturityCeiling' in changes) await owner.model.patchPreferences({ maturityCeiling });
    if (Object.keys(personal).length) await profilePreferences.patch(personal);
    if (changes.interfaceLanguage) publishLanguage(changes.interfaceLanguage);
  }
  const savePrefs = (changes: PreferenceChanges) => {
    // A native disabled control cannot emit user changes, but keep the command boundary authoritative too: a queued
    // event from the exact frame in which model/activity/profile props changed must not cross into either authority.
    if (!ready) return;
    void run(() => patchPreferences(changes));
  };
  async function saveParentalPin(
    current: string | null,
    pin: string | null,
    operationId: string,
  ): Promise<'saved' | 'incorrect' | 'changed' | 'pending' | 'failed'> {
    let expected: 'incorrect' | 'changed' | 'pending' | undefined;
    let pending = false;
    const saved = await run(async () => {
      try {
        const result = await authority.model.setParentalPin(current, pin, operationId);
        pending = result.delivery === 'queued';
      } catch (error) {
        if (error instanceof LibraryServiceError && error.failure.code === 'unauthorized') {
          expected = 'incorrect';
          return;
        }
        if (error instanceof LibraryServiceError && error.failure.code === 'conflict') {
          expected = 'changed';
          return;
        }
        if (
          error instanceof LibraryServiceError &&
          error.failure.code === 'not-ready' &&
          error.failure.retryable
        ) {
          expected = 'pending';
          return;
        }
        throw error;
      }
    });
    return expected ?? (saved ? (pending ? 'pending' : 'saved') : 'failed');
  }
  const removeLibraryDevice = (id: string) => run(() => authority.model.removeDevice(id));

  // What Den's own addons credit, read from their manifests (den-spec attribution-v1). A browser asks only Den's own
  // addons anything; den-atlas's statements stand in while its manifest can't be read or doesn't name them yet, since
  // its rows and the billboard show that data regardless.
  let addonCredits = $state.raw<Credit[][]>([[...ATLAS_FALLBACK]]);
  $effect(() => {
    if (!ready) return;
    const installed = pluginUrls;
    const table = routes;
    let gone = false;
    const creditsOf = async (addon?: Addon | null): Promise<Credit[] | null> => {
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
    const generation = authorityGeneration;
    retrying = true;
    try {
      const current = authority;
      const retries: Promise<unknown>[] = [];
      const preferenceSettingsFailed = !!current.preferences?.policy.settings.error;
      if (
        current.model.connection === 'failed' ||
        current.model.settings.error ||
        (current.activityModel === current.model && preferenceSettingsFailed)
      )
        retries.push(current.model.retry());
      else if (current.connections.snapshot.error) current.connections.rebind();
      if (
        current.activityModel !== current.model &&
        (current.activityModel.connection === 'failed' ||
          current.activityModel.settings.error ||
          preferenceSettingsFailed)
      )
        retries.push(current.activityModel.retry());
      else if (current.simkl?.snapshot.error) current.simkl.rebind();
      await Promise.allSettled(retries);
    } catch {
      // The model snapshots keep the exact retryable failure and this surface stays available for another try.
    } finally {
      if (generation === authorityGeneration) retrying = false;
    }
  }

  async function saveSimkl(token: string | null): Promise<boolean> {
    return run(() =>
      token
        ? authority.activityModel.connectSimkl(token)
        : authority.activityModel.disconnectSimkl(),
    );
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
    return !!approvalId && run(() => authority.activityModel.approveSimklRemovals(approvalId));
  }

  // den-edge's assistant connections are asked about as `model`'s member. On a household split into profiles that is
  // the household, whose connections they are (profiles-v1 §6.1), while the page's own credential may be Owner's.
  const assistantConnectionFetch = $derived.by(() => {
    if (__DEN_TV_LEGACY_JS_CORE__) return Promise.resolve(undefined);
    const current = authority.model;
    return current.ready
      .then(() => current.relayMembership())
      .then(
        (membership) => (membership ? householdAssistantFetch(membership) : undefined),
        (error: unknown) => {
          console.error('asst/membership-read', error);
          return undefined;
        },
      );
  });

  const hasRecoveryCode = $derived(!!recoveryView?.live);
  const selfId = $derived(connections?.diagnostics.selfDeviceId ?? '');

  async function sealHandover(
    handoverKey: string,
    host: string,
    linkKey: string,
    grantTicket?: string,
  ) {
    const { result } = await authority.model.sealPairingHandover(
      handoverKey,
      host,
      linkKey,
      grantTicket,
    );
    if (result.kind !== 'pairing.handover') throw new Error('wrong pairing response');
    return result;
  }

  async function importHistory(
    items: Parameters<LibraryModel['importHistory']>[0],
    operationId: string,
  ) {
    const { result } = await authority.activityModel.importHistory(items, operationId);
    if (result.kind !== 'history.import') throw new Error('wrong history import response');
    return result;
  }

  async function exportHistory() {
    const { result } = await authority.activityModel.exportHistory();
    if (result.kind !== 'history.export') throw new Error('wrong history export response');
    return result;
  }
</script>

<div class="settings">
  <SettingsNav variant="rail" sections={__DEN_TV_LEGACY_JS_CORE__ ? viewerSections : undefined} />
  <div class="page">
    <div class="title">
      <h1>{i18n.text('settings.title')}</h1>
      <ExpandAll label={i18n.text('settings.title')} />
    </div>
    <SettingsNav variant="bar" sections={__DEN_TV_LEGACY_JS_CORE__ ? viewerSections : undefined} />
    {#if failure}<p class="banner bad" role="alert">{i18n.phrase(failure)}</p>{/if}
    {#if !ready}
      <div
        class:bad={!!loadError}
        class="banner settings-load"
        role={loadError ? 'alert' : 'status'}
      >
        <p>{i18n.phrase(loadError ? 'Couldn’t load your settings.' : 'Loading your settings…')}</p>
        {#if loadError}
          <Button
            variant="secondary"
            icon="retry"
            label={i18n.phrase(retrying ? 'Trying again…' : 'Try again')}
            disabled={retrying}
            onclick={() => void retryLoad()}
          />
        {/if}
      </div>
    {/if}
    {#if !__DEN_TV_LEGACY_JS_CORE__ && prefs}
      <PlaybackSection {prefs} {disabled} save={savePrefs} />
    {/if}
    {#if authorityLoaded}
      {#if !__DEN_TV_LEGACY_JS_CORE__}
        {#key authority.model}<ContentSection
            prefs={prefs!}
            {content}
            pinConfigured={connections?.parentalPinConfigured ?? false}
            {disabled}
            save={savePrefs}
            savePin={saveParentalPin}
            verifyPin={(pin) => authority.model.verifyParentalPin(pin)}
            ownerPin={profileAware}
            pinRemovable={connections?.parentalPinRemovable ?? false}
            showProfileLifecycleNotice={profileAware}
          />{/key}
      {:else}
        <SettingsSection id="content" title={i18n.text('settings.section.content')}>
          <SettingRow
            id="profile-lifecycle"
            label={i18n.phrase(
              'This TV is viewer-only. Profile administration is not available on this TV.',
            )}
          />
          <SettingRow
            id="owner-pin-management-handoff"
            label={i18n.phrase('Manage the Owner PIN in a supported browser')}
            detail={i18n.phrase('Owner PIN administration is not available on this TV')}
          >
            <p>
              {i18n.phrase(
                'On a phone or computer linked to this household, open Den › Settings › Content to set, change, or remove the Owner PIN.',
              )}
            </p>
            <p class="mono">{`${__DEN_TV_WEB_ORIGIN__ || location.origin}/settings#content`}</p>
          </SettingRow>
        </SettingsSection>
      {/if}
      {#key authority}<ConnectionsSection
          {link}
          {content}
          {onjoin}
          onresetkey={link && libraryFormat !== null && libraryFormat === 4 && !profileAware
            ? onresetkey
            : undefined}
          oncompoundreset={!__DEN_TV_LEGACY_JS_CORE__ &&
          link &&
          (profileTopology || compoundResetPending)
            ? oncompoundreset
            : undefined}
          {compoundResetPending}
          profileResetBlocked={!!link &&
            profileAware &&
            !compoundResetPending &&
            (!profileTopology || !oncompoundreset)}
          {hasRecoveryCode}
          {heldReset}
          {onadoptheld}
          apiKeys={connections!.apiKeys}
          appleTVTrackerManagement={authority.activityModel === authority.model}
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
          setApiKey={(service, value) => run(() => authority.model.setApiKey(service, value))}
          installPlugin={(url) => run(() => authority.model.installPlugin(url))}
          removePlugin={(url) => run(() => authority.model.removePlugin(url))}
          setPluginTrust={(url, key) => run(() => authority.model.setPluginTrust(url, key))}
          removeServer={(server) => run(() => authority.model.patchServer(server, null))}
          {sealHandover}
          removeDevice={removeLibraryDevice}
          viewerOnly={__DEN_TV_LEGACY_JS_CORE__}
          presentationOwner={joinPresentation}
        />{/key}
      {#snippet recovery()}
        {#key authority.model}
          <RecoveryCode authority={authority.model} view={recoveryView} {ready} {run} />
        {/key}
      {/snippet}
      {#if !__DEN_TV_LEGACY_JS_CORE__}
        <SharingSection
          {link}
          model={authority.model}
          plugins={pluginUrls}
          {routes}
          ready={ready && routesLoaded}
          {sealHandover}
          {selfId}
        />
        {#key authority.model}
          <AssistantsSection
            connectionFetch={assistantConnectionFetch}
            revokeGrant={link && !local
              ? (grant) => authority.model.revokeAssistant(grant)
              : undefined}
            listGrants={link && !local ? () => authority.model.assistantGrants() : undefined}
          />
        {/key}
        <ImportSection
          {ready}
          scope={authority.activityModel}
          {content}
          watched={authority.activityModel.overview.value?.watched ?? []}
          {importHistory}
          {exportHistory}
        />
      {:else}
        <SettingsSection id="sharing" title={i18n.text('settings.section.sharing')}>
          <SettingRow
            id="guest-management-handoff"
            label="Manage guests in a supported browser"
            detail="Guest administration is not available on this TV"
          >
            <p>
              {i18n.phrase(
                'In Den on a browser linked to this household, open Settings › Sharing to invite, extend, limit, relink, or revoke a guest.',
              )}
            </p>
          </SettingRow>
          <SettingRow
            id="profile-key-reset-handoff"
            label={i18n.phrase('Reset profile keys in a supported browser')}
            detail={i18n.phrase('Profile key reset is not available on this TV')}
          >
            <p>
              {i18n.phrase(
                'In Den on a browser linked to this household, open Settings › Connections › Linked devices to reset every profile library key together.',
              )}
            </p>
          </SettingRow>
        </SettingsSection>
        <SettingsSection id="assistants" title={i18n.text('settings.section.assistants')}>
          <SettingRow
            id="assistant-management-handoff"
            label={i18n.phrase('Manage assistants in a supported browser')}
            detail={i18n.phrase('Assistant connections are not available on this TV')}
          >
            <p>
              {i18n.phrase(
                'On a phone or computer linked to this household, open Den › Settings › Assistants.',
              )}
            </p>
            <p class="mono">{`${__DEN_TV_WEB_ORIGIN__ || location.origin}/settings#assistants`}</p>
          </SettingRow>
        </SettingsSection>
      {/if}
      {#key authority.model}<AdvancedSection
          {link}
          onjoin={local && onjoin ? onjoin : undefined}
          recovery={link && !local ? recovery : undefined}
          remoteAccessConfigured={connections?.remoteAccessConfigured ?? false}
          {disabled}
          {selfId}
          pendingActions={connections?.diagnostics.pendingChanges ?? 0}
          {edgeVersion}
          {libraryFormat}
          setRemoteAccess={(credentials) => run(() => authority.model.setRemoteAccess(credentials))}
          viewerOnly={__DEN_TV_LEGACY_JS_CORE__}
          presentationOwner={joinPresentation}
        />{/key}
    {/if}
    {#if !__DEN_TV_LEGACY_JS_CORE__}<AboutSection
        credits={mergeCredits([...addonCredits, [AIRING_CREDIT]])}
      />{/if}
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
