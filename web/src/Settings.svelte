<!-- Settings, as on the TV — every section and every setting, one page: the TV's pushed screens open in place, and
     the choices use the browser's own controls. What's set here is the library's (`set:prefs`, `set:keys`,
     `set:plugins`, `set:servers`, `set:trust`, `set:devices`), sealed, so the TV and this browser share it and den-edge
     can't read it. -->
<script lang="ts">
  import AboutSection from './settings/AboutSection.svelte';
  import AssistantsSection from './settings/AssistantsSection.svelte';
  import ExpandAll from './settings/ExpandAll.svelte';
  import AdvancedSection from './settings/AdvancedSection.svelte';
  import ConnectionsSection from './settings/ConnectionsSection.svelte';
  import ContentSection from './settings/ContentSection.svelte';
  import PlaybackSection from './settings/PlaybackSection.svelte';
  import SettingsNav from './settings/SettingsNav.svelte';
  import SharingSection from './settings/SharingSection.svelte';
  import {
    readDevices,
    readServers,
    readSyncedPrefs,
    readTrust,
    selfEntry,
    type PrefChanges,
  } from './settings/values';
  import { browserClock } from './lib/clock';
  import { thisDevice } from './lib/device.svelte';
  import { links, type Link } from './lib/links.svelte';
  import { dropLocalLibrary } from './lib/localLibrary';
  import type { LibrarySession } from './lib/librarySession.svelte';
  import { ATLAS_FALLBACK, mergeCredits, readAttribution, type Credit } from './settings/credits';
  import { readApiKey, readPlugins } from './lib/prefs';
  import { relayFetch } from './lib/relayFetch';
  import { findAddon, findAtlas, REEL, type Addon } from './lib/scout';
  import { fetchRoutes, type Routes } from './lib/routes';
  import { ensureSyncPolicy } from './lib/syncLoader';
  import { tmdbKeyOf } from './lib/tmdb';
  import type { ConfigValue, SettingsRow } from './lib/wire';

  /** `link` is null for a browser using its own library (`session.local`), with no TV linked yet. */
  let { link, session }: { link: Link | null; session: LibrarySession } = $props();

  /** undefined while it opens; null when this browser can't reach the library. */
  const log = $derived(session.log);
  /** Bumped after a write: the log isn't reactive. */
  const version = $derived(session.revision);
  const clock = browserClock();
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

  $effect(() => {
    const opened = log;
    if (opened) clock.see(opened.newestStamp());
  });

  const group = (name: string) => {
    void version;
    return log?.settings(name);
  };
  const prefs = $derived(readSyncedPrefs(group('prefs')));
  const keys = $derived(group('keys'));
  const plugins = $derived(readPlugins(group('plugins')));
  const servers = $derived(readServers(group('servers')));
  const trust = $derived(readTrust(group('trust')));
  const devicesRow = $derived(group('devices'));
  const devices = $derived(readDevices(devicesRow));
  const disabled = $derived(!log || saving);

  // What Den's own addons credit, read from their manifests (den-spec attribution-v1). A browser asks only Den's own
  // addons anything; den-atlas's statements stand in while its manifest can't be read or doesn't name them yet, since
  // its rows and the billboard show that data regardless.
  let addonCredits = $state<Credit[][]>([[...ATLAS_FALLBACK]]);
  $effect(() => {
    const installed = plugins;
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

  /**
   * Set settings in one group, or clear one with null — stamped now, together, merged over what another device last
   * wrote. `quiet` keeps a failure to itself, for a write the viewer didn't ask for.
   */
  async function write(
    name: string,
    changes: Record<string, ConfigValue | null>,
    quiet = false,
  ): Promise<boolean> {
    if (!log) return false;
    if (!quiet) {
      saving = true;
      failure = null;
    }
    try {
      await ensureSyncPolicy();
      const base: SettingsRow = log.settings(name) ?? { kind: 'set', schema: 2, name, values: {} };
      const at = clock.issue();
      const values = { ...base.values };
      for (const [setting, value] of Object.entries(changes)) values[setting] = { value, at };
      const saved = await log.write({ ...base, values });
      if (log.moved) {
        if (link) links.forgetMoved(link);
        return false;
      }
      if (!saved) {
        if (!quiet) failure = 'Couldn’t save that. Check that this device is on your network.';
        return false;
      }
      session.changed(true);
      return true;
    } catch {
      if (!quiet) failure = 'Couldn’t prepare or save that change. Please try again.';
      return false;
    } finally {
      if (!quiet) saving = false;
    }
  }

  const savePrefs = (changes: PrefChanges) => void write('prefs', changes);

  /**
   * Linking a TV from a browser using its own library: every row goes into the TV's library, merged with what the TV
   * has, and only then is this browser's own library dropped.
   */
  async function moveOwnLibrary(libraryKey: string): Promise<boolean> {
    const own = session.log;
    if (!own || !(await own.moveTo(libraryKey))) return false;
    await own.forget();
    await dropLocalLibrary();
    return true;
  }

  // This browser lists itself among the devices with the library, as each device does when it opens it: again when its
  // name changes, and otherwise at most once a day.
  $effect(() => {
    if (!log) return;
    const entry = selfEntry(
      devicesRow,
      { id: clock.device, name: thisDevice.name, kind: 'browser' },
      Date.now(),
    );
    if (!entry) return;
    const timer = setTimeout(() => void write('devices', entry, true), 1000);
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
    {#if log === undefined}
      <p class="banner" role="status">Loading your settings…</p>
    {:else if log === null}
      <p class="banner" role="alert">
        Your library can’t be reached right now, so your settings are read-only. Check that this
        device is on your network.
      </p>
    {/if}
    {#if failure}<p class="banner bad" role="alert">{failure}</p>{/if}

    <ConnectionsSection
      {link}
      onjoin={session.local ? moveOwnLibrary : undefined}
      {keys}
      {plugins}
      {routes}
      {servers}
      {trust}
      {devices}
      selfId={clock.device}
      {disabled}
      {write}
    />
    <SharingSection {link} {plugins} {routes} ready={!!log} />
    <AssistantsSection />
    <PlaybackSection {prefs} {disabled} save={savePrefs} />
    <ContentSection
      {prefs}
      tmdbKey={tmdbKeyOf(keys)}
      pin={readApiKey(keys, 'parentalPIN')}
      {disabled}
      save={savePrefs}
      savePin={(pin) => write('keys', { parentalPIN: pin ? { string: pin } : null })}
    />
    <AdvancedSection
      {keys}
      {disabled}
      selfId={clock.device}
      pendingActions={log?.pendingActions ?? 0}
      {edgeVersion}
      {write}
    />
    <AboutSection {edgeVersion} credits={mergeCredits(addonCredits)} />
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

  .settings :global(.primary),
  .settings :global(.quiet) {
    min-height: 40px;
    padding: 0 18px;
    border-radius: 999px;
    font: inherit;
    font-size: 15px;
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
  }

  .settings :global(.primary) {
    border: 0;
    background: var(--accent);
    color: #fff;
  }

  .settings :global(.quiet) {
    border: 1px solid var(--line);
    background: none;
    color: var(--fg);
  }

  .settings :global(.primary:disabled),
  .settings :global(.quiet:disabled) {
    opacity: 0.4;
    cursor: default;
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
    .settings :global(.form .primary),
    .settings :global(.form .quiet) {
      flex: 1 1 auto;
    }
  }
</style>
