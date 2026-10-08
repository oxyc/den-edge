<!-- Settings › Connections, as on the TV: media servers, trackers, the user's own keys, plugins and linked devices.
     Everything here is the library's (`set:keys`, `set:servers`, `set:plugins`, `set:trust`, `set:devices`), sealed,
     so the TV and this browser share it and den-edge can't read it. What only a TV can do — sign in to Trakt, connect a
     server on its own network — says where to do it. -->
<script lang="ts">
  import { onMount, untrack, type Snippet } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import Confirm from './Confirm.svelte';
  import RecoveryRedeem from '../components/RecoveryRedeem.svelte';
  import SettingRow from './SettingRow.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import { KEY_SERVICES, keyStatus, type KeyCheck, type KeyService } from './keys';
  import {
    deviceStatus,
    libraryName,
    syncedDeviceRows,
    type LinkedDeviceRow,
  } from './linkedDevices';
  import { fetchSimklClientId, pollToken, requestPin, type SimklPin } from './simkl';
  import { parsePublicKey } from './preferences';
  import { thisDevice } from '../lib/device.svelte';
  import type { GrantAddon } from '../lib/grants';
  import { guestGrants } from '../lib/grants.svelte';
  import { receiveDeviceIdentities } from '../lib/inbox';
  import { links, type Link, type Shared } from '../lib/links.svelte';
  import { navigate } from '../lib/navigation';
  import { formatCode, host, join, parseCode, type HostError, type JoinError } from '../lib/pair';
  import { acceptsAddonURL } from '../lib/prefs';
  import type { Routes } from '../lib/routes';
  import { routePath } from '../lib/route';
  import { denAddonOf } from '../lib/scout';
  import { clearTmdbCache } from '../lib/tmdbCache';
  import type {
    ConnectionsView,
    KeyResetOutcome,
    LibraryApiKeyService,
    LibraryDeviceView,
    LibraryPluginView,
  } from '../lib/libraryServiceProtocol';
  import type { Immutable } from '../lib/libraryModel.svelte';

  let {
    link,
    apiKeys,
    rawApiKeys,
    simklConnected,
    saveSimkl,
    heldRemovals = [],
    approveRemovals,
    plugins,
    routes,
    servers,
    devices,
    selfId,
    disabled,
    setApiKey,
    installPlugin,
    removePlugin,
    setPluginTrust,
    removeServer,
    sealHandover,
    removeDevice,
    onjoin,
    onresetkey,
    hasRecoveryCode = false,
    heldReset = false,
    onadoptheld,
    recovery,
  }: {
    /** Null for a browser using its own library, with no TV linked yet. */
    link: Link | null;
    apiKeys: ConnectionsView['apiKeys'];
    rawApiKeys: Partial<Record<LibraryApiKeyService, string>>;
    simklConnected: boolean;
    saveSimkl: (token: string | null) => Promise<boolean>;
    /** SIMKL watchlist removals held back until someone approves them (more than 20 at once). */
    heldRemovals?: { type: 'movie' | 'tv'; id: number; name?: string }[];
    approveRemovals?: () => Promise<boolean>;
    plugins: readonly Immutable<LibraryPluginView>[];
    routes: Routes;
    servers: readonly {
      readonly kind: 'jellyfin' | 'plex';
      readonly url: string;
      readonly user?: string;
    }[];
    devices: readonly Immutable<LibraryDeviceView>[];
    /** This browser's id in the device list. */
    selfId: string;
    disabled: boolean;
    setApiKey: (service: LibraryApiKeyService, value: string | null) => Promise<boolean>;
    installPlugin: (manifestUrl: string) => Promise<boolean>;
    removePlugin: (manifestUrl: string) => Promise<boolean>;
    setPluginTrust: (manifestUrl: string, publicKey: string | null) => Promise<boolean>;
    removeServer: (server: 'jellyfin' | 'plex') => Promise<boolean>;
    sealHandover: (
      handoverKey: string,
      host: string,
      linkKey: string,
    ) => Promise<{ sealed: string; linkKey: string; inboxKey: string }>;
    /** False when the device's entry wasn't removed. */
    removeDevice: (id: string) => Promise<boolean>;
    /**
     * For a browser using its own library: moves that library into the one `libraryKey` opens, before the browser
     * links to it, so what was saved here goes along. False when it couldn't.
     */
    onjoin?: (libraryKey: string) => Promise<boolean>;
    /**
     * Moves the library to a new key, cutting off every other device (library v4 §12). Null when it moved, else why it
     * didn't. Absent where this browser can't: no linked library, or one not on v4 yet.
     */
    onresetkey?: () => Promise<KeyResetOutcome | null>;
    /** The library has a recovery code, which a reset ends. */
    hasRecoveryCode?: boolean;
    /** A reset whose outcome den-edge couldn't prove is held, its new key kept (`PendingReset.held`). */
    heldReset?: boolean;
    /** Use the held reset's new key: the person says this browser made it. */
    onadoptheld?: () => Promise<void>;
    /** The library's recovery code, under Linked devices; none for a browser's own library. */
    recovery?: Snippet;
  } = $props();

  const apiService = (name: KeyService['name']): LibraryApiKeyService =>
    name === 'doesthedogdie' ? 'content-warnings' : name;

  /**
   * A library opened with a recovery code (recovery-code §8 step 5): what this browser saved on its own moves in
   * first, as when it links a TV; then it opens the recovered library from now on.
   */
  async function openRecovered(libraryKey: string): Promise<boolean> {
    if (onjoin && !(await onjoin(libraryKey))) return false;
    links.addRecovered(libraryKey);
    location.assign('/');
    return true;
  }

  const hostOf = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };
  const day = (at: number) =>
    new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  // Keys: checked with their service before they're kept, and the saved ones checked once as the page opens, as
  // the TV checks its keys at launch.
  const checks = new SvelteMap<string, KeyCheck | 'checking'>();
  let drafts = $state<Record<string, string>>({ tmdb: '', omdb: '', doesthedogdie: '' });
  let notes = $state<Record<string, { text: string; bad: boolean }>>({});
  const serviceName = { tmdb: 'TMDB', omdb: 'OMDb', doesthedogdie: 'doesthedogdie' };
  const savedNote = {
    tmdb: 'Saved — discovery is loading.',
    omdb: 'Saved — ratings are enabled.',
    doesthedogdie: 'Saved — content warnings are enabled.',
  };
  let checkedOnOpen = false;
  $effect(() => {
    if (checkedOnOpen || disabled) return;
    checkedOnOpen = true;
    for (const service of KEY_SERVICES) {
      const key = rawApiKeys[apiService(service.name)];
      if (!key) continue;
      checks.set(service.name, 'checking');
      void service.check(key).then((result) => checks.set(service.name, result));
    }
  });

  async function saveKey(service: KeyService) {
    const key = drafts[service.name]?.trim() ?? '';
    if (!key) return;
    const before = checks.get(service.name);
    checks.set(service.name, 'checking');
    notes[service.name] = { text: `Checking with ${serviceName[service.name]}…`, bad: false };
    const result = await service.check(key);
    if (result !== 'accepted') {
      if (before) checks.set(service.name, before);
      else checks.delete(service.name);
      notes[service.name] = {
        text:
          result === 'refused'
            ? `${serviceName[service.name]} didn’t accept this key.`
            : `Couldn’t reach ${serviceName[service.name]}. Try again in a moment.`,
        bad: true,
      };
      return;
    }
    if (!(await setApiKey(apiService(service.name), key))) {
      if (before) checks.set(service.name, before);
      else checks.delete(service.name);
      delete notes[service.name];
      return;
    }
    drafts[service.name] = '';
    checks.set(service.name, 'accepted');
    notes[service.name] = { text: savedNote[service.name], bad: false };
  }

  async function removeKey(service: KeyService) {
    if (!(await setApiKey(apiService(service.name), null))) return;
    checks.delete(service.name);
    delete notes[service.name];
    // TMDB's terms: cached content goes when the key it was fetched with does.
    if (service.name === 'tmdb') await clearTmdbCache();
  }

  // Addons another library shares with this browser (`grants.svelte.ts`): listed, never editable, and not the library's.
  const sharedLabels: Record<GrantAddon, string> = {
    scout: 'Den Scout',
    atlas: 'Den Atlas',
    reel: 'Den Reel',
    subtitles: 'Den Subtitles',
  };
  const sharedAddons = $derived(
    guestGrants.list.flatMap((grant) =>
      grant.ended
        ? []
        : (Object.keys(grant.addons) as GrantAddon[]).map((addon) => ({
            gid: grant.gid,
            host: grant.name,
            addon,
          })),
    ),
  );

  // Plugins, and the signing key each can be pinned to.
  let addonDraft = $state('');
  let addonProblem = $state<string | null>(null);
  const addonURL = $derived(addonDraft.trim().replace(/\/+$/, ''));
  async function addPlugin() {
    if (!acceptsAddonURL(addonURL)) {
      addonProblem =
        'Use https://, or http:// for an address on your network (localhost, *.local, 10.x, 172.16–31.x, 192.168.x).';
      return;
    }
    addonProblem = null;
    const url = addonURL;
    if (!(await installPlugin(url))) return;
    addonDraft = '';
    added = url;
  }

  /**
   * The plugin just added here, until a TV lists it as waiting. A TV installs a plugin only once its own user
   * approves it there: an addon runs on the TV with the household's keys, so no other device can install one on it.
   */
  let added = $state<string | null>(null);
  let pinning = $state<string | null>(null);
  let keyDraft = $state('');
  let keyInvalid = $state(false);
  async function pinKey(url: string) {
    const key = parsePublicKey(keyDraft);
    keyInvalid = !key;
    if (!key) return;
    if (await setPluginTrust(url, key)) {
      pinning = null;
      keyDraft = '';
    }
  }

  // Away from home lives in Advanced; SIMKL's token is here, as a connection.
  const simkl = $derived(simklConnected);

  // SIMKL sign-in, with the code SIMKL gives, as on the TV. den-edge publishes the app's client id; without one, Connect
  // is left to the TV. Each attempt has a number, so a cancelled or superseded one stops at its next step.
  let simklClientId = $state<string | null>(null);
  void fetchSimklClientId().then((id) => (simklClientId = id));
  let simklPin = $state<SimklPin | null>(null);
  let simklNote = $state<{ text: string; bad: boolean } | null>(null);
  /** Said when an approval found the held list changed under it. */
  let removalsNote = $state<string | null>(null);
  let simklAttempt = 0;
  $effect(() => () => {
    simklAttempt++;
  });

  async function connectSimkl() {
    const clientId = simklClientId;
    if (!clientId) return;
    const attempt = ++simklAttempt;
    simklNote = null;
    const pin = await requestPin(clientId);
    if (attempt !== simklAttempt) return;
    if (!pin) {
      simklNote = { text: 'Couldn’t get a code from SIMKL. Try again in a moment.', bad: true };
      return;
    }
    simklPin = pin;
    const expires = Date.now() + pin.expiresIn * 1000;
    let wait = pin.interval;
    while (Date.now() < expires) {
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      if (attempt !== simklAttempt) return;
      const answer = await pollToken(clientId, pin.userCode);
      if (attempt !== simklAttempt) return;
      if (answer.kind === 'authorized') {
        simklPin = null;
        if (await saveSimkl(answer.token)) simklNote = { text: 'Connected to SIMKL.', bad: false };
        return;
      }
      if (answer.kind === 'failed') {
        simklPin = null;
        simklNote = {
          text: 'Couldn’t reach SIMKL. Check your connection and try again.',
          bad: true,
        };
        return;
      }
      if (answer.kind === 'slowDown') wait += 5;
    }
    simklPin = null;
    simklNote = { text: 'The code expired — try again.', bad: true };
  }

  function cancelSimkl() {
    simklAttempt++;
    simklPin = null;
  }

  const httpsOnly = (url: string) => {
    try {
      return new URL(url).protocol === 'https:' ? url : undefined;
    } catch {
      return undefined;
    }
  };

  // Linking another device: this browser hosts the pairing the TV would.
  let code = $state<string | null>(null);
  let asking = $state<string | null>(null);
  let pairing = $state(false);
  let pairNotice = $state<string | null>(null);
  let answer = $state<((allowed: boolean) => void) | null>(null);
  const pairFailures: Record<HostError, string> = {
    unreachable: 'Couldn’t reach Den. Check that this device is on your network.',
    busy: 'Too many pairings started here just now. Wait a minute and try again.',
    failed: 'That pairing didn’t finish. Show a new code and try again.',
    insecure:
      'Linking needs a secure connection. Open Den over https (not a plain http address) and try again.',
  };
  /** Whether the code shown was put on the clipboard, so the page can say so. */
  let codeCopied = $state(false);
  /** Ends a pairing this page started, hosting or joining, when the page goes. */
  const leaving = new AbortController();
  onMount(() => () => {
    leaving.abort();
    answer?.(false);
  });
  /**
   * Put `text` on the clipboard. Safari only allows a write that starts inside the tap, so a code that
   * arrives later goes in as a promised item started now; a browser that refuses leaves the code on screen.
   */
  function copyCode(text: string | Promise<string>) {
    const blob = Promise.resolve(text).then((t) => new Blob([t], { type: 'text/plain' }));
    const write =
      typeof ClipboardItem === 'function' && navigator.clipboard?.write
        ? navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })])
        : Promise.resolve(text).then((t) => navigator.clipboard?.writeText(t));
    void write.then(
      () => (codeCopied = true),
      (error: unknown) => console.warn('link code not copied', error),
    );
  }
  function selectCode(event: Event) {
    const element = event.currentTarget as HTMLElement;
    getSelection()?.selectAllChildren(element);
    if (code) copyCode(formatCode(code).text);
  }
  async function linkDevice() {
    // A browser's own library is kept only here, so another device given its key would find nothing on den-edge.
    if (!link) return;
    pairing = true;
    pairNotice = null;
    codeCopied = false;
    let shown: (text: string) => void = () => {};
    let noCode: (reason: Error) => void = () => {};
    copyCode(
      new Promise<string>((resolve, reject) => {
        shown = resolve;
        noCode = reject;
      }),
    );
    const result = await host({
      signal: leaving.signal,
      seal: sealHandover,
      label: thisDevice.name,
      deviceId: selfId,
      onCode: (next) => {
        code = next;
        shown(formatCode(next).text);
      },
      allow: (joiner) =>
        new Promise<boolean>((resolve) => {
          code = null;
          asking = joiner;
          answer = (allowed) => {
            asking = null;
            answer = null;
            resolve(allowed);
          };
        }),
    });
    // Settles the promised clipboard item when the pairing ended before any code was shown.
    noCode(new Error('no code was shown'));
    code = null;
    pairing = false;
    if ('joiner' in result) {
      const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
      links.share(result.joiner, link.libraryKey, {
        inboxKey: result.inboxKey,
        linkKey: base64(result.linkKey),
      });
    }
    pairNotice =
      'joiner' in result ? `${result.joiner} now has your library.` : pairFailures[result.error];
  }

  function unlink(target: Link) {
    links.remove(target.inboxKey);
    // The library this page was reading is gone; the app goes back to linking.
    if (target.inboxKey === link?.inboxKey) navigate('/');
  }

  // Joining another TV's library: a browser has no library of its own to merge, so it links to that TV as it linked
  // to this one, and opens that library from then on. The TV it's linked to now stays listed until it's unlinked.
  let joinCode = $state('');
  let joining = $state(false);
  let joinProblem = $state<string | null>(null);
  const joinFailures: Record<JoinError, string> = {
    expired: 'That code has expired or doesn’t exist. Get a new one on the other TV.',
    claimed: 'That code was already used. Get a new one on the other TV.',
    throttled: 'Too many tries. Wait a minute and try again.',
    unreachable: 'Couldn’t reach Den. Check that this device is on your network.',
    mistyped: 'That isn’t a whole code: it’s 12 letters and digits.',
    failed:
      'The other TV didn’t link this browser: the code didn’t match, or it wasn’t allowed. Get a new code there.',
    insecure:
      'Linking needs a secure connection. Open Den over https (not a plain http address) and try again.',
  };
  async function joinLibrary() {
    joining = true;
    joinProblem = null;
    const result = await join(joinCode, {
      label: thisDevice.name,
      deviceId: selfId,
      signal: leaving.signal,
    });
    joining = false;
    if ('error' in result) {
      joinProblem = joinFailures[result.error];
      return;
    }
    const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
    const { host: name, hostDeviceId, libraryKey, linkKey } = result.handover;
    const key = base64(libraryKey);
    // What this browser saved on its own goes into the TV's library before the browser switches to it, so a move that
    // fails leaves it where it was.
    if (onjoin) {
      joining = true;
      const moved = await onjoin(key);
      joining = false;
      if (!moved) {
        joinProblem = `Couldn’t move what you saved here into ${name}’s library. Check that this device is on your network, then get a new code on the TV and try again.`;
        return;
      }
    }
    links.add(result.inboxKey, {
      name,
      libraryKey: key,
      linkKey: base64(linkKey),
      deviceId: hostDeviceId,
    });
    joinCode = '';
    if (key === link?.libraryKey) {
      joinProblem = `${name} already shares this library: it's linked to this browser too.`;
      return;
    }
    links.makeCurrent(result.inboxKey);
    // A new library is a new session from the start: reloaded, the app opens the one now first in the list.
    location.assign('/');
  }

  const deviceIcon = (device: { name: string; kind?: string }) => {
    if (device.kind === 'tv' || device.name.includes('Apple TV')) return 'tv';
    if (/iPhone|phone|iPad|tablet/i.test(device.name)) return 'phone';
    return 'computer';
  };
  const listedDevices = $derived(
    syncedDeviceRows(
      devices.map((device) => ({
        ...device,
        seen: device.lastSeenAt,
        format: device.libraryFormat,
        pending: [],
        facade: [],
        delivers: [],
        waiting: {},
        connectedAt: {},
        handoff: {},
      })),
      links.list,
      links.shared,
      link?.libraryKey,
    ),
  );

  /**
   * Drain sealed pairing identities while Settings is open. A linked device can resend after an upgrade, rename, or
   * stamp-id change, so learning the first id must not stop later authenticated updates from being applied.
   *
   * Every device's queue in one request per check (`receiveDeviceIdentities`), not one each. Only a device handed the
   * library in the last few minutes, still without an id, gets quick retries, since its message may still be on the
   * way. A check runs only while Settings is the page on screen in a visible tab: the page is kept, hidden, once
   * another is opened (`RoutePage`), and went on draining every 30 seconds for the rest of the visit.
   */
  const FRESH_PAIRING_MS = 10 * 60_000;
  const QUICK_TRIES = 8;
  // Deliberately non-reactive: starting or finishing a check must not retrigger the effect below.
  let learning = false;
  // A check asked for while one runs (a device shared meanwhile) runs once that one ends, rather than not at all.
  let again = false;
  const onScreen = () =>
    document.visibilityState === 'visible' &&
    !document.getElementById('connections')?.closest('[hidden]');
  const credentialOf = (entry: Shared) =>
    entry.inboxKey && entry.linkKey ? { inboxKey: entry.inboxKey, linkKey: entry.linkKey } : null;
  async function learnIdentities() {
    if (!onScreen()) return;
    if (learning) {
      again = true;
      return;
    }
    learning = true;
    try {
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Local to one check; nothing renders from it.
      const answered = new Set<string>();
      for (let attempt = 0; attempt < QUICK_TRIES; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500));
        const now = Date.now();
        const asked = links.shared.filter(
          (entry) =>
            credentialOf(entry) &&
            !answered.has(entry.inboxKey!) &&
            (attempt === 0 || (!entry.deviceId && now - entry.at < FRESH_PAIRING_MS)),
        );
        if (!asked.length) return;
        const found = await receiveDeviceIdentities(asked.map((entry) => credentialOf(entry)!));
        for (const entry of asked) {
          const identity = found.get(entry.inboxKey!);
          if (!identity) continue;
          answered.add(entry.inboxKey!);
          links.identifyShared(entry, identity.name, identity.deviceId);
        }
      }
    } finally {
      learning = false;
      if (again) {
        again = false;
        void learnIdentities();
      }
    }
  }
  $effect(() => {
    void links.shared;
    untrack(() => void learnIdentities());
  });
  onMount(() => {
    const check = () => void learnIdentities();
    const interval = window.setInterval(check, 30_000);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', check);
    };
  });

  // Resetting the library key: every other device is cut off and pairs again; this browser keeps the library.
  let resetting = $state(false);
  let resetProblem = $state<string | null>(null);
  const resetFailures: Partial<Record<KeyResetOutcome, string>> = {
    'update-required':
      'Your library holds something only a newer version of Den can move. Update Den on your devices, then try again.',
    unavailable:
      'Couldn’t move your library to a new key, so nothing changed. Check that this device is on your network and try again.',
    unknown:
      'Den lost the connection at the last step, so it can’t tell yet whether your library has its new key. Nothing is lost either way. Den checks again by itself while Settings is open; you can also press Reset library key again to check now.',
    moved:
      'Another device reset your library’s key first, so this browser no longer has it. Pair it again with a code from that device.',
    held: 'Reset outcome unknown: the new key is kept.',
  };
  async function resetKey() {
    if (!onresetkey) return;
    resetting = true;
    resetProblem = null;
    const refused = await onresetkey();
    resetting = false;
    // A held reset has its own panel, with the way out.
    if (refused && refused !== 'held')
      resetProblem = resetFailures[refused] ?? 'Couldn’t reset the library key.';
  }

  /**
   * One step for the viewer: the device's entry in the library's list, then this browser's own record of giving it the
   * library. Neither takes the library away from it; only a new library key does.
   */
  async function removeRow(row: LinkedDeviceRow) {
    if (row.device && !(await removeDevice(row.device.id))) return;
    for (const shared of row.shared) links.forgetShared(shared);
  }
</script>

{#snippet icon(kind: string)}
  <svg class="icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    {#if kind === 'tv'}
      <rect x="3" y="5" width="18" height="12" rx="2" /><path d="M8 20h8" />
    {:else if kind === 'phone'}
      <rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 18h2" />
    {:else}
      <rect x="5" y="5" width="14" height="10" rx="1.5" /><path d="M3 19h18" />
    {/if}
  </svg>
{/snippet}

<SettingsSection id="connections" title="Connections">
  <SettingRow
    id="servers"
    label="Jellyfin / Plex servers"
    value={servers.length ? `${servers.length} server${servers.length === 1 ? '' : 's'}` : 'None'}
  >
    {#if servers.length}
      <ul class="list">
        {#each servers as server (server.kind)}
          <li class="line">
            <span class="label"
              >{server.kind === 'jellyfin' ? 'Jellyfin' : 'Plex'}<small>{hostOf(server.url)}</small
              ></span
            >
            <Confirm
              label="Remove"
              question="Remove your {server.kind === 'jellyfin' ? 'Jellyfin' : 'Plex'} server?"
              detail="Titles will stop playing from your own library, on every device."
              {disabled}
              onconfirm={() => void removeServer(server.kind)}
            />
          </li>
        {/each}
      </ul>
    {/if}
    <p class="foot">
      Connect a server on your Apple TV, under Settings › Jellyfin / Plex servers: it signs in on
      your home network, and the server then reaches your other devices through your library.
      Matched titles play from your library first — instant, no rate limits.
    </p>
  </SettingRow>

  <SettingRow id="trakt" label="Trakt" value="On each Apple TV">
    <p class="foot">
      Trakt syncs your watch history and records what you watch. Connect it on each Apple TV, under
      Settings › Trakt: its sign-in renews itself with every use, so two devices can’t share one.
    </p>
  </SettingRow>

  <SettingRow
    id="simkl"
    label="SIMKL"
    value={!simkl
      ? 'Not connected'
      : heldRemovals.length === 0
        ? 'Connected'
        : heldRemovals.length === 1
          ? '1 removal held'
          : `${heldRemovals.length} removals held`}
  >
    {#if simkl && heldRemovals.length && approveRemovals}
      <div class="form">
        <p>
          Den held back these watchlist removals because there were so many at once:
          {#each heldRemovals as title, i (`${title.type}:${title.id}`)}<a
              href={routePath({ page: 'title', type: title.type, id: title.id })}
              >{title.name ?? `${title.type === 'movie' ? 'Movie' : 'Series'} ${title.id}`}</a
            >{i < heldRemovals.length - 1 ? ', ' : '.'}{/each}
          Approve to remove them from your SIMKL watchlist too. Approving here counts for every device.
        </p>
        <Confirm
          label={`Remove ${heldRemovals.length === 1 ? '1 title' : `${heldRemovals.length} titles`} from SIMKL`}
          question={`Remove ${heldRemovals.length === 1 ? 'this title' : `these ${heldRemovals.length} titles`} from your SIMKL watchlist?`}
          detail="This can't be undone."
          {disabled}
          onconfirm={() =>
            void approveRemovals().then(
              (approved) =>
                (removalsNote = approved
                  ? null
                  : 'The list changed while you were looking at it. Check it again before approving.'),
            )}
        />
        {#if removalsNote}<p class="status bad" role="status">{removalsNote}</p>{/if}
      </div>
    {/if}
    {#if simkl}
      <div class="form">
        <Confirm
          label="Disconnect"
          question="Disconnect SIMKL?"
          detail="Den stops syncing your watch history with it, on every device."
          {disabled}
          onconfirm={() => void saveSimkl(null)}
        />
      </div>
    {:else if simklPin}
      {@const link = httpsOnly(simklPin.verificationUrl)}
      <div class="pair">
        <p>
          Go to {#if link}<a href={link} target="_blank" rel="noreferrer noopener"
              >{simklPin.verificationUrl.replace(/^https:\/\//, '')}</a
            >{:else}{simklPin.verificationUrl}{/if} and enter this code:
        </p>
        <b class="code">{simklPin.userCode}</b>
        <p class="status" role="status">Waiting for SIMKL…</p>
        <button type="button" class="quiet" onclick={cancelSimkl}>Cancel</button>
      </div>
    {:else if simklClientId}
      <div class="form">
        <button type="button" class="primary" {disabled} onclick={() => void connectSimkl()}
          >Connect SIMKL</button
        >
      </div>
    {/if}
    {#if simklNote}<p class="status" class:bad={simklNote.bad} role="status">
        {simklNote.text}
      </p>{/if}
    <p class="foot">
      SIMKL (<a href="https://simkl.com" target="_blank" rel="noreferrer noopener">simkl.com</a>)
      syncs your watch history and records what you watch. {simkl
        ? 'The sign-in reaches your devices through your library.'
        : simklClientId
          ? 'Connect it here or on your Apple TV, and it reaches your other devices through your library.'
          : 'Connect it on your Apple TV, under Settings › SIMKL, and it reaches your other devices through your library.'}
    </p>
  </SettingRow>

  {#each KEY_SERVICES as service (service.name)}
    {@const saved = !!apiKeys[apiService(service.name)]}
    {@const note = notes[service.name]}
    <SettingRow
      id={service.name}
      label={service.label}
      detail={service.detail}
      value={keyStatus(saved, checks.get(service.name))}
    >
      <form
        class="form"
        onsubmit={(event) => {
          event.preventDefault();
          void saveKey(service);
        }}
      >
        <input
          id="{service.name}-key"
          class="field"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder={saved ? 'Saved — type to replace' : service.placeholder}
          aria-label="{service.label} API key"
          bind:value={drafts[service.name]}
        />
        <button
          class="primary"
          disabled={disabled ||
            !drafts[service.name]?.trim() ||
            checks.get(service.name) === 'checking'}>Save &amp; validate</button
        >
        {#if saved}
          <Confirm
            label="Remove"
            question="Remove your {serviceName[service.name]} key?"
            detail={service.name === 'tmdb'
              ? 'Search, posters and details stop on every device that has no key of its own, and cached TMDB data is cleared.'
              : 'It’s removed from every device.'}
            {disabled}
            onconfirm={() => void removeKey(service)}
          />
        {/if}
      </form>
      {#if note}<p class="status" class:bad={note.bad} role="status">{note.text}</p>{/if}
      <p class="foot">
        {service.about} It reaches your devices through your library, sealed: den-edge can’t read it.
      </p>
    </SettingRow>
  {/each}

  <SettingRow id="plugins" label="Plugins" value={plugins.length ? String(plugins.length) : ''}>
    <h3>Your plugins</h3>
    {#if plugins.length}
      <ul class="list">
        {#each plugins as plugin (plugin.manifestUrl)}
          {@const url = plugin.manifestUrl}
          {@const den = denAddonOf(url, routes)}
          {@const pinned = plugin.signingKey}
          {@const waitingOn = plugin.pendingApprovalOn}
          <li class="line">
            <span class="label"
              >{den?.label ?? hostOf(url)}<small
                >{den ? `${den.role} · ${hostOf(url)}` : 'Plugin'}</small
              >{#if pinned}<small>Verified — Den checks this plugin’s signature</small
                >{/if}{#if waitingOn.length}<small
                  >Waiting for approval on {waitingOn.map((d) => d.name).join(', ')}: approve it
                  there under Settings › Plugins</small
                >{:else if added === url}<small
                  >Approve it on your Apple TV under Settings › Plugins</small
                >{/if}</span
            >
            <span class="actions">
              {#if pinned}
                <Confirm
                  label="Stop verifying"
                  question="Stop verifying this plugin?"
                  detail="Den will accept its index without checking a signature, as before."
                  {disabled}
                  onconfirm={() => void setPluginTrust(url, null)}
                />
              {:else if pinning !== url}
                <button
                  type="button"
                  class="quiet"
                  {disabled}
                  onclick={() => {
                    pinning = url;
                    keyDraft = '';
                    keyInvalid = false;
                  }}>Pin signing key</button
                >
              {/if}
              <Confirm
                label="Remove"
                question="Remove {den?.label ?? hostOf(url)}?"
                detail="You can add it back by its URL."
                {disabled}
                onconfirm={() => void removePlugin(url)}
              />
            </span>
            {#if pinning === url}
              <form
                class="form wide"
                onsubmit={(event) => {
                  event.preventDefault();
                  void pinKey(url);
                }}
              >
                <input
                  id="signing-key"
                  class="field mono"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="ed25519:…"
                  aria-label="Signing key for {den?.label ?? hostOf(url)}"
                  bind:value={keyDraft}
                />
                <button class="primary" disabled={disabled || !keyDraft.trim()}>Pin key</button>
                <button type="button" class="quiet" onclick={() => (pinning = null)}>Cancel</button>
              </form>
              {#if keyInvalid}
                <p class="status bad wide" role="alert">
                  That isn’t a valid key. Paste the ed25519:… public key the plugin publishes.
                </p>
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
    {:else if !sharedAddons.length}
      <p class="status">No plugins yet. Add a manifest URL below.</p>
    {/if}
    {#if sharedAddons.length}
      <h3>Shared with you</h3>
      <ul class="list">
        {#each sharedAddons as shared (`${shared.gid}/${shared.addon}`)}
          <li class="line">
            <span class="label"
              >{sharedLabels[shared.addon]}<small>Shared by {shared.host} · read-only</small></span
            >
          </li>
        {/each}
      </ul>
    {/if}
    <p class="foot">
      A plugin sees what you browse and supplies what you play, so an Apple TV installs one only
      once it's approved — on the TV, or here, which approves it on the TVs this browser is linked
      to. Removing one declines it. A dataset plugin can sign what it publishes: pin its key and Den
      will only accept an index that plugin signed.
    </p>
    <h3>Add manually</h3>
    <form
      class="form"
      onsubmit={(event) => {
        event.preventDefault();
        void addPlugin();
      }}
    >
      <input
        id="plugin-url"
        class="field"
        type="url"
        autocomplete="off"
        spellcheck="false"
        placeholder="https://…/manifest.json (or http:// on your LAN)"
        aria-label="Plugin manifest URL"
        bind:value={addonDraft}
      />
      <button class="primary" disabled={disabled || !addonURL}>Add plugin</button>
    </form>
    {#if addonProblem}<p class="status bad" role="alert">{addonProblem}</p>{/if}
  </SettingRow>

  <SettingRow
    id="linked-devices"
    label="Linked devices"
    detail="Your devices, your library, and joining another"
    value={listedDevices.length
      ? `${listedDevices.length} device${listedDevices.length === 1 ? '' : 's'}`
      : 'None'}
  >
    <h3>Devices</h3>
    {#if listedDevices.length}
      <ul class="list">
        {#each listedDevices as row (row.id)}
          <li class="line">
            {@render icon(deviceIcon(row))}
            <span class="label"
              >{row.name}<small>{deviceStatus(row, selfId, link?.libraryKey, day)}</small></span
            >
            {#if row.device?.id === selfId}
              <button type="button" class="quiet" disabled>This device</button>
            {:else}
              <Confirm
                label="Remove"
                ariaLabel="Remove {row.name}"
                question="Remove {row.name} from this list?"
                detail="It can still use your library, and shows up again the next time it opens it."
                disabled={!!row.device && disabled}
                onconfirm={() => void removeRow(row)}
              />
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="status">None yet: a device shows up here when it next opens your library.</p>
    {/if}
    {#if heldReset}
      <div class="pair" role="alert">
        <p>
          <b>Reset outcome unknown.</b> Your library’s old key no longer works, but Den can’t tell whether
          this browser’s reset retired it. The new key is kept here, so nothing is lost. If you reset
          the key on this browser just now, use the new key. If another device also reset the key, pair
          again with a code from it instead.
        </p>
        <button type="button" class="primary" onclick={() => void onadoptheld?.()}
          >Use the new key</button
        >
      </div>
    {/if}
    {#if onresetkey}
      <div class="form">
        <Confirm
          label={resetting ? 'Resetting…' : 'Reset library key…'}
          question="Reset your library key?"
          detail={`Your library moves to a new key, with everything in it. Every other device — your Apple TV too — loses it and must pair again with a code; this browser keeps it.${hasRecoveryCode ? ' Your recovery code stops working.' : ''}`}
          confirmLabel="Reset key"
          disabled={disabled || resetting}
          onconfirm={() => void resetKey()}
        />
      </div>
      {#if resetting}<p class="status" role="status">Moving your library to a new key…</p>{/if}
      {#if resetProblem}<p class="status bad" role="alert">{resetProblem}</p>{/if}
      {#if links.keyReset}
        <p class="status" role="status">
          Your library has a new key. Pair your other devices again: get a code below, or on the
          Apple TV under Settings › Linked devices.
        </p>
      {/if}
      <p class="foot">
        To cut a device off, reset the library key. Removing it from the list doesn’t: it still
        holds the key.
      </p>
    {:else}
      <p class="foot">
        To cut a device off, reset the library key on your Apple TV under Settings › Linked devices.
      </p>
    {/if}

    {@render recovery?.()}

    {#if links.list.length}
      <h3>Your library</h3>
      <ul class="list">
        {#each links.list as linked (linked.inboxKey)}
          {@const current = linked.inboxKey === link?.inboxKey}
          <li class="line">
            <span class="label"
              >{libraryName(linked, link?.libraryKey)}<small
                >{current
                  ? 'Open on this browser'
                  : `Saved on this browser${linked.name ? ` · joined through ${linked.name}` : ''}`}</small
              ></span
            >
            {#if current}
              <Confirm
                label="Sign out on this browser"
                question="Sign out of your library on this browser?"
                detail="Your other devices keep it, and you can join it again with a code."
                confirmLabel="Sign out"
                onconfirm={() => unlink(linked)}
              />
            {:else}
              <Confirm
                label="Remove"
                ariaLabel="Remove the library joined through {linked.name ?? 'another device'}"
                question="Remove this library from this browser?"
                detail="Your other devices keep it."
                onconfirm={() => unlink(linked)}
              />
            {/if}
          </li>
        {/each}
      </ul>
      <p class="foot">Signing out only affects this browser.</p>
    {/if}

    <h3 id="join-library-label">{link ? 'Join another library' : 'Link your Apple TV'}</h3>
    <form
      class="form"
      onsubmit={(event) => {
        event.preventDefault();
      }}
    >
      <input
        id="join-library-code"
        class="field mono"
        autocomplete="off"
        spellcheck="false"
        autocapitalize="characters"
        placeholder="ABCD-EFGH-JKLM"
        aria-labelledby="join-library-label"
        value={joinCode}
        oninput={(event) => (joinCode = formatCode(event.currentTarget.value).text)}
      />
      <Confirm
        label={joining ? 'Waiting…' : link ? 'Join' : 'Link'}
        question={link ? 'Switch this browser to that library?' : 'Link this browser to that TV?'}
        detail={link
          ? 'Your current library stays listed under Your library.'
          : 'What you’ve saved here moves into that TV’s library, and this browser uses that library from then on.'}
        confirmLabel={link ? 'Join' : 'Link'}
        tone="primary"
        disabled={joining || !parseCode(joinCode)}
        onconfirm={() => void joinLibrary()}
      />
    </form>
    {#if joining}<p class="status" role="status">Waiting for the TV to allow this browser…</p>{/if}
    {#if joinProblem}<p class="status bad" role="alert">{joinProblem}</p>{/if}
    <p class="foot">
      {#if link}
        Get the code on a device already in that library: in Den under Settings › Linked devices ›
        Get a code, or on its Apple TV under Settings › Linked devices.
      {:else}
        To keep what’s here in your TV’s library, get a code on your Apple TV under Settings ›
        Linked devices and type it here.
      {/if}
    </p>

    <h3>Open with a recovery code</h3>
    <RecoveryRedeem
      question={link
        ? 'This browser switches to that library. Your current library stays listed under Your library.'
        : 'What you’ve saved here moves into that library, and this browser uses it from then on.'}
      onopen={openRecovered}
    />

    <h3 id="this-device-label">Name of this device</h3>
    <input
      id="this-device"
      class="field"
      value={thisDevice.chosen}
      placeholder={thisDevice.guess}
      oninput={(event) => thisDevice.rename(event.currentTarget.value)}
      autocomplete="off"
      maxlength="40"
      aria-labelledby="this-device-label"
    />
    <p class="foot">Your other devices show this name, so give it its own if two look alike.</p>

    <!-- A browser's own library is kept only here: another device given its key would find nothing on den-edge. -->
    {#if link}
      <h3>Link another device</h3>
      <div class="pair">
        {#if code}
          <p>On your phone or computer, open Den and type this code:</p>
          <b
            class="code"
            role="button"
            tabindex="0"
            title="Copy the code"
            data-no-swipe
            onclick={selectCode}
            onkeydown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              selectCode(event);
            }}>{formatCode(code).text}</b
          >
          <p class="status" role="status">
            {codeCopied ? 'Copied. ' : ''}Waiting for your device…
          </p>
        {:else if asking}
          <p role="alert">
            <b>Allow “{asking}”?</b> It will see your library, and can add to your watchlist, add plugins
            and play on your TV.
          </p>
          <span class="actions">
            <button type="button" class="primary" onclick={() => answer?.(true)}>Allow</button>
            <button type="button" class="quiet" onclick={() => answer?.(false)}>Don’t Allow</button>
          </span>
        {:else}
          {#if pairNotice}<p class="status" role="status">{pairNotice}</p>{/if}
          <button type="button" class="primary" disabled={pairing} onclick={linkDevice}
            >{pairing ? 'Waiting…' : 'Get a code'}</button
          >
        {/if}
      </div>
      <p class="foot">
        Give your library to a phone, a laptop, or Den opened at another address, without going to
        the TV.
      </p>
    {/if}
  </SettingRow>
</SettingsSection>

<style>
  .icon {
    flex-shrink: 0;
    fill: none;
    stroke: var(--muted);
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .pair {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 14px;
    margin-top: 8px;
    padding: 14px 16px;
    border-radius: 12px;
    background: rgb(255 255 255 / 0.03);
  }

  .pair p {
    flex: 1 1 100%;
    margin: 0;
    color: var(--muted);
    font-size: 14px;
  }

  .pair p b {
    color: var(--fg);
  }

  .code {
    font:
      700 24px/1.2 ui-monospace,
      SFMono-Regular,
      Menlo,
      Consolas,
      monospace;
    letter-spacing: 0.12em;
    overflow-wrap: anywhere;

    /* One tap takes the whole code, not the word under the finger. */
    user-select: all;
    -webkit-user-select: all;
    cursor: copy;
  }

  .wide {
    flex-basis: 100%;
  }
</style>
