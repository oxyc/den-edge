<!-- Settings › Connections, as on the TV: media servers, trackers, the user's own keys, plugins and linked devices.
     Everything here is the library's (`set:keys`, `set:servers`, `set:plugins`, `set:trust`, `set:devices`), sealed,
     so the TV and this browser share it and den-edge can't read it. What only a TV can do — sign in to Trakt, connect a
     server on its own network, reset the library key — says where to do it. -->
<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import Confirm from './Confirm.svelte';
  import SettingRow from './SettingRow.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import { KEY_SERVICES, keyStatus, type KeyCheck, type KeyService } from './keys';
  import { fetchSimklClientId, pollToken, requestPin, type SimklPin } from './simkl';
  import { forgetDevice, parsePublicKey, type DeviceEntry } from './values';
  import { thisDevice } from '../lib/device.svelte';
  import { links, type Link } from '../lib/links.svelte';
  import { navigate } from '../lib/navigation';
  import { sendToTV } from '../lib/inbox';
  import { formatCode, host, type HostError } from '../lib/pair';
  import { acceptsAddonURL, readApiKey } from '../lib/prefs';
  import type { Routes } from '../lib/routes';
  import { denAddonOf } from '../lib/scout';
  import { clearTmdbCache } from '../lib/tmdbCache';
  import type { ConfigValue, SettingsRow } from '../lib/wire';

  type Changes = Record<string, ConfigValue | null>;

  let {
    link,
    keys,
    plugins,
    routes,
    servers,
    trust,
    devices,
    selfId,
    disabled,
    write,
  }: {
    link: Link;
    keys: SettingsRow | undefined;
    plugins: string[];
    routes: Routes;
    servers: { kind: 'jellyfin' | 'plex'; url: string; user?: string }[];
    trust: ReadonlyMap<string, string>;
    devices: DeviceEntry[];
    /** This browser's id in the device list. */
    selfId: string;
    disabled: boolean;
    write: (group: string, changes: Changes) => Promise<boolean>;
  } = $props();

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
    if (checkedOnOpen || !keys) return;
    checkedOnOpen = true;
    for (const service of KEY_SERVICES) {
      const key = readApiKey(keys, service.name);
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
    if (!(await write('keys', { [service.name]: { string: key } }))) {
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
    if (!(await write('keys', { [service.name]: null }))) return;
    checks.delete(service.name);
    delete notes[service.name];
    // TMDB's terms: cached content goes when the key it was fetched with does.
    if (service.name === 'tmdb') await clearTmdbCache();
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
    if (!(await write('plugins', { [url]: { bool: true } }))) return;
    addonDraft = '';
    // Added here is approved here: the TVs this browser is paired with install it without asking again.
    await approve(url);
  }

  /** What each plugin's approval came to, as the row says it. */
  let approvals = $state<Record<string, { text: string; bad: boolean }>>({});

  /**
   * Approves a plugin on the TVs this browser is paired with, through each TV's inbox (den-spec inbox-v1
   * `approveAddon`): the link is what shows the TV the approval comes from a device its user allowed.
   */
  async function approve(url: string) {
    if (!links.list.length) {
      approvals[url] = { text: 'Waiting for approval on your Apple TV.', bad: false };
      return;
    }
    const sent = await Promise.all(
      links.list.map((tv) => sendToTV(tv, { type: 'approveAddon', manifestUrl: url })),
    );
    const reached = sent.filter(Boolean).length;
    approvals[url] = reached
      ? {
          text:
            reached === links.list.length
              ? 'Approved: your Apple TV installs it when it next checks in.'
              : 'Approved on some of your Apple TVs; the others didn’t answer.',
          bad: reached !== links.list.length,
        }
      : { text: 'Couldn’t reach your Apple TV. Try again in a moment.', bad: true };
  }
  let pinning = $state<string | null>(null);
  let keyDraft = $state('');
  let keyInvalid = $state(false);
  async function pinKey(url: string) {
    const key = parsePublicKey(keyDraft);
    keyInvalid = !key;
    if (!key) return;
    if (await write('trust', { [url]: { string: key } })) {
      pinning = null;
      keyDraft = '';
    }
  }

  // Away from home lives in Advanced; SIMKL's token is here, as a connection.
  const simkl = $derived(!!readApiKey(keys, 'simkl'));

  // SIMKL sign-in, with the code SIMKL gives, as on the TV. den-edge publishes the app's client id; without one, Connect
  // is left to the TV. Each attempt has a number, so a cancelled or superseded one stops at its next step.
  let simklClientId = $state<string | null>(null);
  void fetchSimklClientId().then((id) => (simklClientId = id));
  let simklPin = $state<SimklPin | null>(null);
  let simklNote = $state<{ text: string; bad: boolean } | null>(null);
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
        if (await write('keys', { simkl: { string: answer.token } }))
          simklNote = { text: 'Connected to SIMKL.', bad: false };
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
  async function linkDevice() {
    pairing = true;
    pairNotice = null;
    const libraryKey = Uint8Array.from(atob(link.libraryKey), (c) => c.charCodeAt(0));
    const result = await host({
      libraryKey,
      label: thisDevice.name,
      onCode: (shown) => (code = shown),
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
    code = null;
    pairing = false;
    if ('joiner' in result) links.share(result.joiner);
    pairNotice =
      'joiner' in result ? `${result.joiner} now has your library.` : pairFailures[result.error];
  }

  function unlink(target: Link) {
    links.remove(target.inboxKey);
    // The library this page was reading is gone; the app goes back to linking.
    if (target.inboxKey === link.inboxKey) navigate('/');
  }

  const deviceIcon = (device: { name: string; kind?: string }) => {
    if (device.kind === 'tv' || device.name.includes('Apple TV')) return 'tv';
    if (/iPhone|phone|iPad|tablet/i.test(device.name)) return 'phone';
    return 'computer';
  };
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
              onconfirm={async () => {
                const changes: Changes = { [server.kind]: null };
                if (server.kind === 'jellyfin') changes['jellyfin.user'] = null;
                if (await write('servers', changes)) await write('keys', { [server.kind]: null });
              }}
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

  <SettingRow id="simkl" label="SIMKL" value={simkl ? 'Connected' : 'Not connected'}>
    {#if simkl}
      <div class="form">
        <Confirm
          label="Disconnect"
          question="Disconnect SIMKL?"
          detail="Den stops syncing your watch history with it, on every device."
          {disabled}
          onconfirm={() => void write('keys', { simkl: null })}
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
    {@const saved = !!readApiKey(keys, service.name)}
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
        {#each plugins as url (url)}
          {@const den = denAddonOf(url, routes)}
          {@const pinned = trust.get(url)}
          {@const waitingOn = devices.filter((d) => d.kind === 'tv' && d.pending.includes(url))}
          {@const approval = approvals[url]}
          <li class="line">
            <span class="label"
              >{den?.label ?? hostOf(url)}<small
                >{den ? `${den.role} · ${hostOf(url)}` : 'Plugin'}</small
              >{#if pinned}<small>Verified — Den checks this plugin’s signature</small
                >{/if}{#if approval}<small class:bad={approval.bad}>{approval.text}</small
                >{:else if waitingOn.length}<small
                  >Waiting for approval on {waitingOn.map((d) => d.name).join(', ')}</small
                >{/if}</span
            >
            <span class="actions">
              {#if waitingOn.length && links.list.length && !approval}
                <button type="button" class="primary" {disabled} onclick={() => void approve(url)}
                  >Install</button
                >
              {/if}
              {#if pinned}
                <Confirm
                  label="Stop verifying"
                  question="Stop verifying this plugin?"
                  detail="Den will accept its index without checking a signature, as before."
                  {disabled}
                  onconfirm={() => void write('trust', { [url]: null })}
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
                onconfirm={() => void write('plugins', { [url]: null })}
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
    {:else}
      <p class="status">No plugins yet. Add a manifest URL below.</p>
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
    value={devices.length ? `${devices.length} linked` : 'Not linked'}
  >
    <h3>Devices with your library</h3>
    {#if devices.length}
      <ul class="list">
        {#each devices as device (device.id)}
          <li class="line">
            {@render icon(deviceIcon(device))}
            <span class="label"
              >{device.name}<small
                >{device.id === selfId
                  ? 'This browser'
                  : device.kind === 'tv'
                    ? 'Apple TV'
                    : 'Browser'}{device.seen ? ` · seen ${day(device.seen)}` : ''}</small
              ></span
            >
            {#if device.id !== selfId}
              <Confirm
                label="Remove from list"
                question="Remove {device.name} from the list?"
                detail="It still holds your library’s key, and lists itself again the next time it opens your library. To shut it out, reset the library key on your Apple TV."
                confirmLabel="Remove"
                {disabled}
                onconfirm={() => void write('devices', forgetDevice(device.id))}
              />
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="status">None listed yet: a device lists itself when it next opens your library.</p>
    {/if}

    <h3 id="this-device-label">This browser</h3>
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
    <p class="foot">
      This device only · What another device asks to allow, and lists this one under. Two phones of
      the same make guess the same name, so give this one its own.
    </p>

    <h3>Linked to this browser</h3>
    <ul class="list">
      {#each links.list as linked (linked.inboxKey)}
        <li class="line">
          {@render icon('tv')}
          <span class="label"
            >{linked.name ?? 'Apple TV'}{#if linked.linkedAt}<small
                >linked {day(linked.linkedAt)}</small
              >{/if}</span
          >
          <Confirm
            label="Unlink"
            question="Unlink {linked.name ?? 'this Apple TV'}?"
            detail="This browser stops opening its library. The TV keeps running."
            onconfirm={() => unlink(linked)}
          />
        </li>
      {/each}
      {#each links.shared as device (device.name + device.at)}
        <li class="line">
          {@render icon(deviceIcon(device))}
          <span class="label">{device.name}<small>given your library {day(device.at)}</small></span>
          <button type="button" class="quiet" onclick={() => links.forgetShared(device)}
            >Forget</button
          >
        </li>
      {/each}
    </ul>
    {#if links.shared.length}
      <p class="foot">
        Forgetting one only stops listing it here — it keeps the copy of your library it was given.
      </p>
    {/if}

    <h3>Link another device</h3>
    <div class="pair">
      {#if code}
        <p>On your phone or computer, open Den and type this code:</p>
        <b class="code">{formatCode(code).text}</b>
        <p class="status" role="status">Waiting for your device…</p>
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
      Give your library to a phone, a laptop, or Den opened at another address, without going to the
      TV. Joining another TV’s library and resetting the library key are on your Apple TV, under
      Settings › Linked devices.
    </p>
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
  }

  .wide {
    flex-basis: 100%;
  }
</style>
