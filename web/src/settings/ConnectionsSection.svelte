<!-- Settings › Connections, as on the TV: media servers, trackers, the user's own keys, plugins and linked devices.
     Everything here is the library's (`set:keys`, `set:servers`, `set:plugins`, `set:trust`, `set:devices`), sealed,
     so the TV and this browser share it and den-edge can't read it. What only a TV can do — sign in to Trakt, connect a
     server on its own network — says where to do it. -->
<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import ActionMenu from '../components/ActionMenu.svelte';
  import Button from '../components/Button.svelte';
  import DetailIcon from '../components/DetailIcon.svelte';
  import Confirm from './Confirm.svelte';
  import SettingRow from './SettingRow.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import { KEY_SERVICES, keyStatus, type KeyCheck, type KeyService } from './keys';
  import {
    deviceStatus,
    hasOtherDevices,
    syncedDeviceRows,
    type LinkedDeviceRow,
  } from './linkedDevices';
  import { fetchSimklClientId, pollToken, requestPin, type SimklPin } from './simkl';
  import { parsePublicKey } from './preferences';
  import { thisDevice } from '../lib/device.svelte';
  import { deviceTicket, type GrantAddon } from '../lib/grants';
  import { guestGrants } from '../lib/grants.svelte';
  import {
    hasSharedMediaSettings,
    openGuestConfigure,
    openOwnerConfigure,
  } from '../lib/guestConfigure';
  import { receiveDeviceIdentities } from '../lib/inbox';
  import { links, type Link, type Shared } from '../lib/links.svelte';
  import {
    formatCode,
    give,
    host,
    join,
    parseCode,
    type HostError,
    type JoinError,
  } from '../lib/pair';
  import { acceptsAddonURL } from '../lib/prefs';
  import type { Routes } from '../lib/routes';
  import { routePath } from '../lib/route';
  import { denAddonOf, denConfigureURL } from '../lib/scout';
  import type { MenuItem } from '../lib/titleActions';
  import type {
    ConnectionsView,
    KeyResetOutcome,
    LibraryApiKeyService,
    LibraryDeviceView,
    LibraryPluginView,
  } from '../lib/libraryServiceProtocol';
  import type { Immutable } from '../lib/libraryModel.svelte';
  import type { ContentServiceClientPort } from '../lib/contentServiceClient';
  import type { JoinLibrary, JoinLink } from '../lib/browserHousehold';
  import PinInput from '../components/PinInput.svelte';
  import { parseTVLink } from '../lib/tvLink';

  let {
    link,
    content,
    apiKeys,
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
    profileResetBlocked = false,
    hasRecoveryCode = false,
    heldReset = false,
    onadoptheld,
  }: {
    /** Null for a browser using its own library, with no TV linked yet. */
    link: Link | null;
    content: ContentServiceClientPort;
    apiKeys: ConnectionsView['apiKeys'];
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
      grantTicket?: string,
    ) => Promise<{ sealed: string; linkKey: string; inboxKey: string }>;
    /** False when the device's entry wasn't removed. */
    removeDevice: (id: string) => Promise<boolean>;
    /**
     * For a browser using its own library or household: moves what it keeps into the household `libraryKey` opens,
     * before the browser links to it, so what was saved here goes along (`JoinAnswer`).
     */
    onjoin?: JoinLibrary;
    /**
     * Moves the library to a new key, cutting off every other device (library v4 §12). Null when it moved, else why it
     * didn't. Absent where this browser can't: no linked library, or one not on v4 yet.
     */
    onresetkey?: () => Promise<KeyResetOutcome | null>;
    /** The household has profiles, so the single-library reset is unavailable until the compound reset ships. */
    profileResetBlocked?: boolean;
    /** The library has a recovery code, which a reset ends. */
    hasRecoveryCode?: boolean;
    /** A reset whose outcome den-edge couldn't prove is held, its new key kept (`PendingReset.held`). */
    heldReset?: boolean;
    /** Use the held reset's new key: the person says this browser made it. */
    onadoptheld?: () => Promise<void>;
  } = $props();

  const apiService = (name: KeyService['name']): LibraryApiKeyService =>
    name === 'doesthedogdie' ? 'content-warnings' : name;
  const checkKey = async (service: KeyService, candidate?: string): Promise<KeyCheck> => {
    try {
      const answer = await content.query({
        kind: 'provider-key.check',
        service: apiService(service.name),
        candidate,
      });
      return answer.outcome === 'unavailable' ? 'unreachable' : answer.outcome;
    } catch {
      return 'unreachable';
    }
  };

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
  let drafts = $state.raw<Record<string, string>>({ tmdb: '', omdb: '', doesthedogdie: '' });
  let notes = $state.raw<Record<string, { text: string; bad: boolean }>>({});
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
      if (!apiKeys[apiService(service.name)]) continue;
      checks.set(service.name, 'checking');
      void checkKey(service).then((result) => checks.set(service.name, result));
    }
  });

  async function saveKey(service: KeyService) {
    const key = drafts[service.name]?.trim() ?? '';
    if (!key) return;
    const before = checks.get(service.name);
    checks.set(service.name, 'checking');
    notes = {
      ...notes,
      [service.name]: { text: `Checking with ${serviceName[service.name]}…`, bad: false },
    };
    const result = await checkKey(service, key);
    if (result !== 'accepted') {
      if (before) checks.set(service.name, before);
      else checks.delete(service.name);
      notes = {
        ...notes,
        [service.name]: {
          text:
            result === 'refused'
              ? `${serviceName[service.name]} didn’t accept this key.`
              : `Couldn’t reach ${serviceName[service.name]}. Try again in a moment.`,
          bad: true,
        },
      };
      return;
    }
    if (!(await setApiKey(apiService(service.name), key))) {
      if (before) checks.set(service.name, before);
      else checks.delete(service.name);
      const { [service.name]: _removed, ...remaining } = notes;
      notes = remaining;
      return;
    }
    drafts = { ...drafts, [service.name]: '' };
    checks.set(service.name, 'accepted');
    notes = { ...notes, [service.name]: { text: savedNote[service.name], bad: false } };
  }

  async function removeKey(service: KeyService) {
    if (!(await setApiKey(apiService(service.name), null))) return;
    checks.delete(service.name);
    const { [service.name]: _removed, ...remaining } = notes;
    notes = remaining;
    // TMDB's terms: cached content goes when the key it was fetched with does.
    if (service.name === 'tmdb')
      await content.query({ kind: 'provider-cache.clear', service: 'tmdb' });
  }

  // Addons another library shares with this browser (`grants.svelte.ts`): listed, never editable, and not the library's.
  const sharedLabels: Record<GrantAddon, string> = {
    den: 'Den Hearth',
    scout: 'Den Scout',
    atlas: 'Den Atlas',
    reel: 'Den Reel',
    subtitles: 'Den Subtitles',
  };
  const sharedAddons = $derived(
    guestGrants.list.flatMap((grant) =>
      grant.ended
        ? []
        : (Object.keys(grant.addons) as Array<GrantAddon | 'den'>).flatMap((addon) => {
            // Hearth is the media facade. Once it is available, the legacy Scout/Subtitles/Reel escrow remains
            // an implementation detail for fallback; Atlas is still the one separate discovery addon.
            if (addon === 'den' || (grant.addons.den && addon !== 'atlas')) return [];
            return [{ gid: grant.gid, addon }];
          }),
    ),
  );
  const sharedHosts = $derived(guestGrants.list.filter((grant) => !grant.ended && grant.secret));
  let configuringGuest = $state<string | null>(null);
  let configuringOwner = $state(false);
  let resettingGuest = $state<string | null>(null);
  let configureGuestProblem = $state<string | null>(null);
  let pluginMenus = $state.raw<Record<string, ActionMenu | undefined>>({});
  let guestMenus = $state.raw<Record<string, ActionMenu | undefined>>({});
  let pluginConfirm = $state<{ kind: 'remove' | 'unverify'; url: string } | null>(null);
  let pluginConfirmNext: { kind: 'remove' | 'unverify'; url: string } | null = null;

  function configureGuest(gid: string, secret: string) {
    configuringGuest = gid;
    configureGuestProblem = null;
    if (!openGuestConfigure(gid, secret))
      configureGuestProblem = 'Couldn’t open settings. Reload Den, then try again.';
    if (configuringGuest === gid) configuringGuest = null;
  }

  function configureOwner(url: string) {
    configuringOwner = true;
    addonProblem = null;
    if (!openOwnerConfigure(url))
      addonProblem = 'Couldn’t open settings. Reload Den, then try again.';
    configuringOwner = false;
  }

  async function useSharedSettings(gid: string) {
    resettingGuest = gid;
    configureGuestProblem = null;
    if (!(await guestGrants.useSharedSettings(gid)))
      configureGuestProblem = 'Couldn’t switch to shared settings. Try again in a moment.';
    if (resettingGuest === gid) resettingGuest = null;
  }

  function pluginItems(
    url: string,
    configureURL: string | null | undefined,
    pinned: string | null | undefined,
  ): MenuItem[] {
    const items: MenuItem[] = [];
    if (configureURL)
      items.push({
        kind: 'item',
        label: configuringOwner ? 'Opening setup…' : 'Build new Hearth link',
        disabled: disabled || configuringOwner,
        onselect: () => configureOwner(configureURL),
      });
    if (pinned)
      items.push({
        kind: 'item',
        label: 'Stop verifying signature…',
        disabled,
        onselect: () => (pluginConfirmNext = { kind: 'unverify', url }),
      });
    else
      items.push({
        kind: 'item',
        label: 'Pin signing key',
        disabled,
        onselect: () => {
          pinning = url;
          keyDraft = '';
          keyInvalid = false;
        },
      });
    items.push({
      kind: 'item',
      label: 'Remove add-on…',
      disabled,
      onselect: () => (pluginConfirmNext = { kind: 'remove', url }),
    });
    return items;
  }

  function guestItems(gid: string, secret: string, hasOverride: boolean): MenuItem[] {
    const items: MenuItem[] = [
      {
        kind: 'item',
        label: configuringGuest === gid ? 'Opening settings…' : 'Edit my Hearth settings',
        disabled: configuringGuest !== null || resettingGuest !== null,
        onselect: () => configureGuest(gid, secret),
      },
    ];
    if (hasOverride)
      items.push({
        kind: 'item',
        label: resettingGuest === gid ? 'Switching…' : 'Use shared settings',
        disabled: configuringGuest !== null || resettingGuest !== null,
        onselect: () => void useSharedSettings(gid),
      });
    return items;
  }

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
  let pairSurface = $state<HTMLDivElement>();
  async function focusPair(selector: string) {
    if (!__DEN_TV__) return;
    await tick();
    requestAnimationFrame(() =>
      pairSurface?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true }),
    );
  }
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
    tvAnswer?.(false);
  });
  /**
   * Put `text` on the clipboard. Safari only allows a write that starts inside the tap, so a code that
   * arrives later goes in as a promised item started now; a browser that refuses leaves the code on screen.
   */
  function copyCode(text: string | Promise<string>) {
    const plain = Promise.resolve(text);
    const writeText = () =>
      plain.then((value) => {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        return navigator.clipboard.writeText(value);
      });
    let write: Promise<unknown>;
    if (typeof ClipboardItem === 'function' && navigator.clipboard?.write) {
      const blob = plain.then((value) => new Blob([value], { type: 'text/plain' }));
      try {
        // Older Chromium exposes ClipboardItem but accepts only a Blob, not the promised Blob Safari requires.
        // Constructing it throws synchronously there; copying is best-effort and must never stop pairing itself.
        write = navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      } catch {
        // The rejected no-code promise still owns this derived promise even though the native constructor refused it.
        void blob.catch(() => {});
        write = writeText();
      }
    } else {
      write = writeText();
    }
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
        void focusPair('[data-pair-code]');
      },
      allow: (joiner) =>
        new Promise<boolean>((resolve) => {
          code = null;
          asking = joiner;
          void focusPair('[data-pair-answer]');
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
    void focusPair('[data-pair-start]');
  }

  // A TV with no library can show an HTTPS QR that opens this Settings page. Its ordinary pairing code remains in
  // the fragment, never sent with the page request; read it once and remove it from the address before anything can
  // copy or bookmark it. A person may type the same twelve characters here when their camera cannot scan the QR.
  const scannedTV = parseTVLink(location.href);
  if (scannedTV) history.replaceState(history.state, '', location.pathname + location.search);
  let tvCode = $state(formatCode(scannedTV ?? '').text);
  let tvGiving = $state(false);
  let tvProblem = $state<string | null>(null);
  let tvNotice = $state<string | null>(null);
  let tvAsking = $state<string | null>(null);
  let tvAnswer = $state<((allowed: boolean) => void) | null>(null);
  let tvGrant = $state('');
  const liveGuestGrants = $derived(
    guestGrants.list.filter((grant) => !grant.ended && grant.secret),
  );
  $effect(() => {
    if (!link?.guest) tvGrant = '';
    else if (!tvGrant && liveGuestGrants.length === 1) tvGrant = liveGuestGrants[0]!.gid;
  });

  function typedTVCode(event: Event & { currentTarget: HTMLInputElement }) {
    tvCode = formatCode(event.currentTarget.value).text;
    event.currentTarget.value = tvCode;
  }

  async function giveToTV() {
    if (!link) {
      tvProblem = 'This library is not synced yet, so another device cannot open it.';
      return;
    }
    if (!parseCode(tvCode)) {
      tvProblem = 'That isn’t a whole TV code.';
      return;
    }
    const grant = link.guest
      ? liveGuestGrants.find((candidate) => candidate.gid === tvGrant)
      : undefined;
    if (link.guest && !grant) {
      tvProblem = 'Choose which shared access this TV should use.';
      return;
    }
    tvGiving = true;
    tvProblem = null;
    tvNotice = null;
    let ticket: string | undefined;
    if (grant) {
      const made = await deviceTicket(grant.gid, grant.secret);
      if (!made.ok) {
        tvGiving = false;
        tvProblem =
          made.status === 404 || made.status === 410
            ? `${grant.name}’s shared access has ended. Refresh or choose another one.`
            : 'Couldn’t prepare shared access for the TV. Check your connection and try again.';
        return;
      }
      ticket = made.value.ticket;
    }
    const result = await give(tvCode, {
      seal: sealHandover,
      label: thisDevice.name,
      deviceId: selfId,
      grantTicket: ticket,
      signal: leaving.signal,
      allow: (joiner) =>
        new Promise<boolean>((resolve) => {
          tvAsking = joiner;
          tvAnswer = (allowed) => {
            tvAsking = null;
            tvAnswer = null;
            resolve(allowed);
          };
        }),
    });
    tvGiving = false;
    if ('error' in result) {
      tvProblem = pairFailures[result.error];
      return;
    }
    links.share(result.joiner, link.libraryKey, {
      inboxKey: result.inboxKey,
      linkKey: btoa(String.fromCharCode(...result.linkKey)),
    });
    tvCode = '';
    tvNotice = `${result.joiner} now has ${grant ? `${grant.name}’s shared Den` : 'this Den library'}.`;
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
    await bringInto(base64(libraryKey), {
      inboxKey: result.inboxKey,
      name,
      linkKey: base64(linkKey),
      deviceId: hostDeviceId,
    });
  }

  // The household joined has an Owner PIN, asked once before this browser's household moves in (den#295). The TV's
  // code is spent by then, so the handover waits here for it.
  let joinPin = $state<{ key: string; link: JoinLink } | null>(null);
  let ownerPin = $state('');
  let pinDenied = $state(false);

  /**
   * What this browser saved on its own goes into the TV's library before the browser switches to it, so a move that
   * fails leaves it where it was.
   */
  async function bringInto(key: string, target: JoinLink, pin?: string) {
    const { name } = target;
    if (onjoin) {
      joining = true;
      joinProblem = null;
      const answer = await onjoin(key, { link: target, ...(pin ? { pin } : {}) });
      joining = false;
      if (answer === 'pin-required' || answer === 'pin-wrong') {
        joinPin = { key, link: target };
        pinDenied = answer === 'pin-wrong';
        ownerPin = '';
        return;
      }
      joinPin = null;
      if (answer === 'refused-kids') {
        joinProblem = `${name} doesn’t have profiles yet, so the Kid profiles here have nowhere to go. Set up profiles on ${name} first, then get a new code and link again.`;
        return;
      }
      if (answer !== 'joined') {
        joinProblem = `Couldn’t move what you saved here into ${name}’s library. Check that this device is on your network, then get a new code on the TV and try again.`;
        return;
      }
    }
    links.add(target.inboxKey, {
      name,
      libraryKey: key,
      linkKey: target.linkKey,
      deviceId: target.deviceId,
    });
    joinCode = '';
    if (key === link?.libraryKey) {
      joinProblem = `${name} already shares this library: it's linked to this browser too.`;
      return;
    }
    links.makeCurrent(target.inboxKey);
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
    'profiles-active':
      'Profile libraries need to rotate together. Key reset will be available after Den finishes that update.',
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
        <Button variant="secondary" label="Cancel" onclick={cancelSimkl} />
      </div>
    {:else if simklClientId}
      <div class="form">
        <Button
          variant="primary"
          label="Connect SIMKL"
          {disabled}
          onclick={() => void connectSimkl()}
        />
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
          value={drafts[service.name]}
          oninput={(event) =>
            (drafts = {
              ...drafts,
              [service.name]: (event.currentTarget as HTMLInputElement).value,
            })}
        />
        <Button
          type="submit"
          variant="primary"
          label="Save & validate"
          disabled={disabled ||
            !drafts[service.name]?.trim() ||
            checks.get(service.name) === 'checking'}
        />
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
          {@const configureURL = denConfigureURL(url, routes)}
          {@const pinned = plugin.signingKey}
          {@const waitingOn = plugin.pendingApprovalOn}
          <li class="line addon-line">
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
            <span class="addon-menu">
              <ActionMenu
                bind:this={
                  () => pluginMenus[url], (menu) => (pluginMenus = { ...pluginMenus, [url]: menu })
                }
                items={() => pluginItems(url, configureURL, pinned)}
                label="More actions for {den?.label ?? hostOf(url)}"
                heading={den?.label ?? hostOf(url)}
                triggerClass="addon-trigger"
                onclose={() => {
                  if (pluginConfirmNext?.url === url) pluginConfirm = pluginConfirmNext;
                  pluginConfirmNext = null;
                }}
                glyph={more}
              />
            </span>
            <Confirm
              hideTrigger
              bind:asking={
                () => pluginConfirm?.kind === 'unverify' && pluginConfirm.url === url,
                (asked) => (pluginConfirm = asked ? { kind: 'unverify', url } : null)
              }
              label="Stop verifying"
              question="Stop verifying this add-on?"
              detail="Den will accept its index without checking a signature, as before."
              {disabled}
              onclose={() => pluginMenus[url]?.focus()}
              onconfirm={() => void setPluginTrust(url, null)}
            />
            <Confirm
              hideTrigger
              bind:asking={
                () => pluginConfirm?.kind === 'remove' && pluginConfirm.url === url,
                (asked) => (pluginConfirm = asked ? { kind: 'remove', url } : null)
              }
              label="Remove add-on"
              question="Remove {den?.label ?? hostOf(url)}?"
              detail="This removes the existing add-on from your library. You can add it back by its URL."
              {disabled}
              onclose={() => pluginMenus[url]?.focus()}
              onconfirm={() => void removePlugin(url)}
            />
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
                <Button
                  type="submit"
                  variant="primary"
                  label="Pin key"
                  disabled={disabled || !keyDraft.trim()}
                />
                <Button variant="secondary" label="Cancel" onclick={() => (pinning = null)} />
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
    {#if sharedHosts.length}
      <h3>Shared with you</h3>
      <ul class="list">
        {#each sharedHosts as grant (grant.gid)}
          {@const hasOverride = Boolean(
            grant.addons.den &&
            grant.overrides?.includes('den') &&
            hasSharedMediaSettings(grant.addons),
          )}
          <li class="line addon-line">
            <span class="label"
              >Den Hearth<small
                >{hasOverride ? 'Using your settings' : 'Using shared settings'}</small
              ></span
            >
            <span class="addon-menu">
              <ActionMenu
                bind:this={
                  () => guestMenus[grant.gid],
                  (menu) => (guestMenus = { ...guestMenus, [grant.gid]: menu })
                }
                items={() => guestItems(grant.gid, grant.secret, Boolean(hasOverride))}
                label="More actions for Den Hearth"
                heading="Den Hearth"
                triggerClass="addon-trigger"
                glyph={more}
              />
            </span>
          </li>
        {/each}
        {#each sharedAddons as shared (`${shared.gid}/${shared.addon}`)}
          <li class="line">
            <span class="label"
              >{sharedLabels[shared.addon]}<small>Shared access · read-only</small></span
            >
          </li>
        {/each}
      </ul>
      {#if configureGuestProblem}<p class="status bad" role="alert">{configureGuestProblem}</p>{/if}
    {/if}
    <p class="foot">
      Add-ons can see what you browse and choose what plays. An Apple TV may ask you to approve a
      new one.
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
      <Button type="submit" variant="primary" label="Add plugin" disabled={disabled || !addonURL} />
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
          <li class="line device-line">
            {@render icon(deviceIcon(row))}
            <span class="label">
              {#if row.device?.id === selfId}
                <!-- The name other devices list this one by; clearing it falls back to the guess. -->
                <input
                  class="field name"
                  value={thisDevice.chosen}
                  placeholder={thisDevice.guess}
                  oninput={(event) => thisDevice.rename(event.currentTarget.value)}
                  autocomplete="off"
                  maxlength="40"
                  aria-label="Name of this device"
                />
              {:else}
                {row.name}
              {/if}<small>{deviceStatus(row, selfId, link?.libraryKey, day)}</small></span
            >
            <div
              class="device-action"
              class:self={row.device?.id === selfId}
              class:confirm={row.device?.id !== selfId}
            >
              {#if row.device?.id === selfId}
                <span class="device-self">This device</span>
              {:else}
                <Confirm
                  label="Remove"
                  ariaLabel="Remove {row.name}"
                  question="Remove {row.name} from this list?"
                  detail="It can still use your library, and shows up again the next time it opens it."
                  disabled={!!row.device && disabled}
                  triggerVariant="tertiary"
                  onconfirm={() => void removeRow(row)}
                />
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="status">None yet: a device shows up here when it next opens your library.</p>
    {/if}

    {#if !__DEN_TV__}
      <h3>Link a TV</h3>
      <div class="pair" class:scanned={!!scannedTV}>
        <p>
          {scannedTV
            ? 'This TV is waiting. Confirm what it should receive.'
            : 'Scan the QR shown by a TV without a library, or type its code here.'}
        </p>
        <input
          class="field tv-code"
          value={tvCode}
          oninput={typedTVCode}
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          maxlength="14"
          placeholder="ABCD-EFGH-JKLM"
          aria-label="Code shown on TV"
          disabled={tvGiving}
        />
        {#if link?.guest}
          <label class="tv-grant">
            <span>Shared access for this TV</span>
            <select bind:value={tvGrant} disabled={tvGiving}>
              <option value="">Choose shared Den…</option>
              {#each liveGuestGrants as grant (grant.gid)}
                <option value={grant.gid}>{grant.name} · {grant.gid.slice(-4)}</option>
              {/each}
            </select>
          </label>
        {/if}
        <Button
          variant="primary"
          label={tvGiving ? 'Linking TV…' : 'Link this TV'}
          disabled={tvGiving || !parseCode(tvCode) || !link || (!!link.guest && !tvGrant)}
          onclick={() => void giveToTV()}
        />
        {#if tvAsking}
          <div class="tv-confirm" role="alertdialog" aria-label="Allow this TV?">
            <p><b>Link “{tvAsking}”?</b> It will receive this library and its watchlist.</p>
            <span class="actions">
              <Button variant="primary" label="Allow TV" onclick={() => tvAnswer?.(true)} />
              <Button variant="secondary" label="Don’t allow" onclick={() => tvAnswer?.(false)} />
            </span>
          </div>
        {/if}
        {#if tvNotice}<p class="status" role="status">{tvNotice}</p>{/if}
        {#if tvProblem}<p class="status bad" role="alert">{tvProblem}</p>{/if}
      </div>
    {/if}

    <!-- A browser's own library is kept only here: another device given its key would find nothing on den-edge. -->
    {#if link}
      <h3>Link another device</h3>
      <div class="pair" bind:this={pairSurface}>
        {#if code}
          <p>On your phone or computer, open Den and type this code:</p>
          <b
            class="code"
            role="button"
            tabindex="0"
            title="Copy the code"
            data-pair-code
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
            <Button
              variant="primary"
              label="Allow"
              data-pair-answer
              onclick={() => answer?.(true)}
            />
            <Button variant="secondary" label="Don’t Allow" onclick={() => answer?.(false)} />
          </span>
        {:else}
          {#if pairNotice}<p class="status" role="status">{pairNotice}</p>{/if}
          <Button
            variant="primary"
            label={pairing ? 'Waiting…' : 'Get a code'}
            disabled={pairing}
            data-pair-start
            onclick={linkDevice}
          />
        {/if}
      </div>
      <p class="foot">
        Give your library to a phone, a laptop, or Den opened at another address, without going to
        the TV.
      </p>
    {/if}

    {#if heldReset}
      <div class="pair" role="alert">
        <p>
          <b>Reset outcome unknown.</b> Your library’s old key no longer works, but Den can’t tell whether
          this browser’s reset retired it. The new key is kept here, so nothing is lost. If you reset
          the key on this browser just now, use the new key. If another device also reset the key, pair
          again with a code from it instead.
        </p>
        <Button variant="primary" label="Use the new key" onclick={() => void onadoptheld?.()} />
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
    {:else if profileResetBlocked}
      <p class="foot">
        Profile libraries need to rotate together. Key reset will be available after Den finishes
        that update.
      </p>
    {:else}
      <p class="foot">
        To cut a device off, reset the library key on your Apple TV under Settings › Linked devices.
      </p>
    {/if}

    <!-- A browser already in a library shared with other devices has no use for joining another one. -->
    {#if !link || !hasOtherDevices(listedDevices, selfId, link.libraryKey)}
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
            ? 'Your current library stays saved on this browser.'
            : 'What you’ve saved here moves into that TV’s library, and this browser uses that library from then on.'}
          confirmLabel={link ? 'Join' : 'Link'}
          tone="primary"
          disabled={joining || !parseCode(joinCode)}
          onconfirm={() => void joinLibrary()}
        />
      </form>
      {#if joinPin}
        {@const pending = joinPin}
        <form
          class="form join-pin"
          onsubmit={(event) => {
            event.preventDefault();
            if (/^\d{4}$/.test(ownerPin)) void bringInto(pending.key, pending.link, ownerPin);
          }}
        >
          <p class="foot">
            {pending.link.name} has an Owner PIN. Enter it to bring your history and Kid profiles here
            into
            {pending.link.name}’s profiles.
          </p>
          <PinInput
            id="join-owner-pin"
            label="{pending.link.name}’s Owner PIN"
            bind:value={ownerPin}
            focusOnMount
            invalid={pinDenied}
            onvalue={() => (pinDenied = false)}
          />
          {#if pinDenied}<p class="status bad" role="alert">That PIN didn’t match.</p>{/if}
          <Button
            type="submit"
            label={joining ? 'Moving…' : 'Link'}
            variant="primary"
            disabled={joining || !/^\d{4}$/.test(ownerPin)}
          />
        </form>
      {/if}
      {#if joining}<p class="status" role="status">
          {joinPin ? 'Moving what you saved here…' : 'Waiting for the TV to allow this browser…'}
        </p>{/if}
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
    {/if}
  </SettingRow>
</SettingsSection>

{#snippet more()}
  <DetailIcon name="more" />
{/snippet}

<style>
  .icon {
    flex-shrink: 0;
    fill: none;
    stroke: var(--muted);
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* A device and its compact action are one row even on a narrow phone. The confirmation itself expands below the
     row so its explanation and two safe targets still have room. */
  li.line.device-line {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
  }

  .device-line .label {
    grid-column: 2;
  }

  .device-action {
    grid-column: 3;
  }

  /* The self row's action column is a status, not an unavailable action. Anchor it to the rename field instead of
     centering it against the field plus the smaller "seen" line below. */
  .device-self {
    display: flex;
    align-items: center;
    min-height: 44px;
    color: var(--muted);
    font-size: 14px;
  }

  .device-action.self {
    align-self: start;
  }

  .field.name {
    margin-bottom: 4px;
  }

  .device-action.confirm {
    grid-column: 1 / -1;
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

  .pair.scanned {
    outline: 1px solid var(--accent);
    outline: 1px solid color-mix(in srgb, var(--accent) 60%, transparent);
  }

  .tv-code {
    flex: 1 1 210px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .tv-grant {
    display: grid;
    flex: 1 1 220px;
    gap: 4px;
    color: var(--muted);
    font-size: 13px;
  }

  .tv-grant select {
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--card);
    color: var(--fg);
  }

  .tv-confirm {
    display: flex;
    flex: 1 1 100%;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }

  .tv-confirm .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
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

  /* Keep an add-on row to its identity and one compact action at every width. ActionMenu turns the same control
     into a bottom sheet for a narrow or touch screen. */
  .addon-line .label {
    flex-basis: 0;
  }

  .addon-menu {
    position: relative;
    flex: 0 0 auto;
  }

  .addon-menu :global(.addon-trigger) {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    color: var(--muted);
  }

  .addon-menu :global(.addon-trigger:hover),
  .addon-menu :global(.addon-trigger[aria-expanded='true']) {
    background: #fff2;
    color: var(--fg);
  }

  .addon-menu :global(.addon-trigger:focus-visible) {
    outline: var(--ring-width) solid var(--focus-ring);
  }
</style>
