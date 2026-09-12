<!-- Settings, as on the TV: the user's own API keys and addons — kept in the library's settings (`set:keys`,
     `set:plugins`), sealed, so the TV and this browser share them and den-edge can't read them — and the linked TV. -->
<script lang="ts">
  import Loading from './components/Loading.svelte';
  import { browserClock } from './lib/clock';
  import { ensureSyncPolicy } from './lib/syncLoader';
  import { thisDevice } from './lib/device.svelte';
  import { links, type Link } from './lib/links.svelte';
  import type { LibrarySession } from './lib/librarySession.svelte';
  import { acceptsAddonURL, readApiKey, readPlugins } from './lib/prefs';
  import { formatCode, host, type HostError } from './lib/pair';
  import { fetchRoutes, type Routes } from './lib/routes';
  import { denAddonOf } from './lib/scout';
  import { clearTmdbCache } from './lib/tmdbCache';
  import type { ConfigValue, SettingsRow } from './lib/wire';

  let { link, session }: { link: Link; session: LibrarySession } = $props();

  const services = [
    { name: 'tmdb', label: 'TMDB', hint: 'Search, and every title’s poster and details.' },
    { name: 'omdb', label: 'OMDb', hint: 'IMDb, Rotten Tomatoes and Metacritic ratings.' },
    { name: 'doesthedogdie', label: 'DoesTheDogDie', hint: 'Content warnings.' },
  ];

  /** undefined while it opens; null when this browser can't reach the library. */
  const log = $derived(session.log);
  /** Bumped after a write: the log isn't reactive. */
  const version = $derived(session.revision);
  let drafts = $state<Record<string, string>>(
    Object.fromEntries(services.map((s) => [s.name, ''])),
  );
  let saving = $state(false);
  let failure = $state<string | null>(null);
  const clock = browserClock();
  /** Tells Den's own plugins apart, so they're listed by name rather than by a LAN address. */
  let routes = $state<Routes>({});
  void fetchRoutes().then((fetched) => (routes = fetched));

  $effect(() => {
    const opened = log;
    if (opened) clock.see(opened.newestStamp());
  });

  const keys = $derived.by(() => {
    void version;
    return log?.settings('keys');
  });
  const plugins = $derived.by(() => {
    void version;
    return readPlugins(log?.settings('plugins'));
  });

  /** Set settings in one group, or clear one with null — stamped now, together, merged over what the TV last wrote. */
  async function write(
    group: string,
    changes: Record<string, ConfigValue | null>,
  ): Promise<boolean> {
    if (!log) return false;
    saving = true;
    failure = null;
    try {
      await ensureSyncPolicy();
      const base: SettingsRow = log.settings(group) ?? {
        kind: 'set',
        schema: 2,
        name: group,
        values: {},
      };
      const at = clock.issue();
      const values = { ...base.values };
      for (const [name, value] of Object.entries(changes)) values[name] = { value, at };
      const row: SettingsRow = { ...base, values };
      const saved = await log.write(row);
      if (log.moved) {
        links.forgetMoved(link);
        return false;
      }
      if (!saved) {
        failure = 'Couldn’t save that. Check that this device is on your network.';
        return false;
      }
      session.changed(true);
      return true;
    } catch {
      failure = 'Couldn’t prepare or save that change. Please try again.';
      return false;
    } finally {
      saving = false;
    }
  }

  async function save(name: string, value: string | null) {
    if (!(await write('keys', { [name]: value ? { string: value } : null }))) return;
    drafts[name] = '';
    // TMDB's terms: cached content goes when the key it was fetched with does.
    if (name === 'tmdb' && !value) await clearTmdbCache();
  }

  let addonDraft = $state('');
  /** Trailing slashes dropped, so the same addon typed twice is one entry. */
  const addonURL = $derived(addonDraft.trim().replace(/\/+$/, ''));

  async function addPlugin() {
    if (!acceptsAddonURL(addonURL)) {
      failure =
        'Use https://, or http:// for an address on your network (localhost, *.local, 10.x, 172.16–31.x, 192.168.x).';
      return;
    }
    if (await write('plugins', { [addonURL]: { bool: true } })) addonDraft = '';
  }

  // The Cloudflare Access service token (oxyc/den#15): typing its 64-character secret on a TV is painful, so it can
  // be entered here and reaches every TV through the library.
  let accessId = $state('');
  let accessSecret = $state('');
  const hasAccess = $derived(
    !!readApiKey(keys, 'cfAccessId') && !!readApiKey(keys, 'cfAccessSecret'),
  );

  /** Both halves together, or both cleared: one without the other opens nothing. */
  async function saveAccess(clear = false) {
    const [id, secret] = clear ? [null, null] : [accessId.trim(), accessSecret.trim()];
    if (!clear && (!id || !secret)) return;
    const value = (v: string | null) => (v ? { string: v } : null);
    if (await write('keys', { cfAccessId: value(id), cfAccessSecret: value(secret) })) {
      accessId = '';
      accessSecret = '';
    }
  }

  function hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  // Handing the library to another browser: this one hosts the pairing the TV would, so a laptop — or Den opened
  // at another address — can join without the TV being to hand.
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

  async function linkBrowser() {
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

  const when = (at: number) =>
    new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  // Unlinking asks twice: a second press within a few seconds confirms, so a stray tap does nothing. The link
  // awaiting its second press is held by key, so one row's confirmation never arms another's.
  let confirming = $state<string | null>(null);
  function unlink(target: Link) {
    if (confirming !== target.inboxKey) {
      confirming = target.inboxKey;
      setTimeout(() => (confirming = null), 4000);
      return;
    }
    confirming = null;
    links.remove(target.inboxKey);
    // The library this screen was reading is gone; the app sends you back to linking.
    if (target.inboxKey === link.inboxKey) location.hash = '';
  }
</script>

<section>
  <h1>Settings</h1>

  <h2>Your keys</h2>
  <p class="sub">
    Your own API keys, shared with your Apple TV through your library. They’re sealed: den-edge
    can’t read them.
  </p>
  {#if log === undefined}
    <Loading label="Loading settings" page />
  {:else if log === null}
    <p class="sub">Your keys live in your library, which this browser can’t reach right now.</p>
  {:else}
    {#each services as service (service.name)}
      {@const current = readApiKey(keys, service.name)}
      <form
        class="key"
        onsubmit={(event) => {
          event.preventDefault();
          void save(service.name, drafts[service.name]?.trim() || null);
        }}
      >
        <div class="label"><b>{service.label}</b><span>{service.hint}</span></div>
        <div class="row">
          <input
            type="password"
            autocomplete="off"
            spellcheck="false"
            placeholder={current ? 'Saved — type to replace' : 'Not set'}
            aria-label={`${service.label} API key`}
            bind:value={drafts[service.name]}
          />
          <button class="primary" disabled={saving || !drafts[service.name]?.trim()}>Save</button>
          {#if current}
            <button
              type="button"
              class="quiet"
              disabled={saving}
              onclick={() => save(service.name, null)}>Remove</button
            >
          {/if}
        </div>
      </form>
    {/each}

    <h2>Away from home</h2>
    <p class="sub">
      The Cloudflare Access service token that lets your Apple TVs in other homes reach your
      plugins. Enter it once: it reaches every TV through your library.
    </p>
    <form
      class="key"
      onsubmit={(event) => {
        event.preventDefault();
        void saveAccess();
      }}
    >
      <div class="row">
        <input
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder={hasAccess ? 'Client ID saved — type to replace' : 'Client ID'}
          aria-label="Access client ID"
          bind:value={accessId}
        />
      </div>
      <div class="row">
        <input
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder={hasAccess ? 'Client secret saved — type to replace' : 'Client secret'}
          aria-label="Access client secret"
          bind:value={accessSecret}
        />
        <button class="primary" disabled={saving || !accessId.trim() || !accessSecret.trim()}
          >Save</button
        >
        {#if hasAccess}
          <button type="button" class="quiet" disabled={saving} onclick={() => saveAccess(true)}
            >Remove</button
          >
        {/if}
      </div>
    </form>

    <h2>Plugins</h2>
    <p class="sub">
      Your addons, shared with your Apple TV through your library. One you add here waits on the TV
      until you install it there.
    </p>
    {#each plugins as url (url)}
      {@const den = denAddonOf(url, routes)}
      <div class="plugin">
        <div class="label">
          <b>{den?.label ?? hostOf(url)}</b><span>{den?.role ?? 'Plugin'}</span>
        </div>
        <button class="quiet" disabled={saving} onclick={() => write('plugins', { [url]: null })}
          >Remove</button
        >
      </div>
    {:else}
      <p class="sub">No plugins yet.</p>
    {/each}
    <form
      class="row"
      onsubmit={(event) => {
        event.preventDefault();
        void addPlugin();
      }}
    >
      <input
        type="url"
        autocomplete="off"
        spellcheck="false"
        placeholder="https://…/manifest.json"
        aria-label="Plugin manifest URL"
        bind:value={addonDraft}
      />
      <button class="primary" disabled={saving || !addonURL}>Add</button>
    </form>
  {/if}
  {#if failure}<p class="error" role="alert">{failure}</p>{/if}

  <h2>This device</h2>
  <p class="sub">
    What the other device asks to allow, and lists this one under. Two phones of the same make guess
    the same name, so give this one its own.
  </p>
  <div class="row">
    <input
      value={thisDevice.chosen}
      placeholder={thisDevice.guess}
      oninput={(event) => thisDevice.rename(event.currentTarget.value)}
      autocomplete="off"
      maxlength="40"
      aria-label="This device’s name"
    />
  </div>

  <h2>Linked devices</h2>
  <p class="sub">
    The libraries this browser can open. Unlinking is this browser’s own business; the device keeps
    running.
  </p>
  {#each links.list as linked (linked.inboxKey)}
    <div class="device">
      <div class="label">
        {linked.name ?? 'Apple TV'}
        {#if linked.linkedAt}<span>Linked {when(linked.linkedAt)}</span>{/if}
      </div>
      <button class="quiet danger" onclick={() => unlink(linked)}>
        {confirming === linked.inboxKey ? 'Press again to unlink' : 'Unlink'}
      </button>
    </div>
  {/each}

  <h2>Another browser</h2>
  <p class="sub">
    Give this library to a browser on another device — a laptop, or Den opened at another address —
    without going to the TV. Open Den there and type the code this shows.
  </p>
  <div class="tv">
    {#if code}
      <b class="code">{formatCode(code).text}</b>
    {:else if asking}
      <span>Allow <b>{asking}</b> to use your library?</span>
    {:else}
      <span>{pairNotice ?? 'Not pairing'}</span>
    {/if}
    {#if asking}
      <button class="primary" onclick={() => answer?.(true)}>Allow</button>
      <button class="quiet" onclick={() => answer?.(false)}>Refuse</button>
    {:else}
      <button class="quiet" disabled={pairing} onclick={linkBrowser}
        >{pairing ? 'Waiting…' : 'Show a code'}</button
      >
    {/if}
  </div>
  {#each links.shared as device (device.name + device.at)}
    <div class="device">
      <div class="label">
        {device.name}
        <span>Given your library {when(device.at)}</span>
      </div>
      <button class="quiet" onclick={() => links.forgetShared(device)}>Forget</button>
    </div>
  {/each}
  {#if links.shared.length}
    <p class="sub note">
      Forgetting one only stops listing it here — it keeps the copy of your library it was given.
    </p>
  {/if}
</section>

<style>
  section {
    max-width: 640px;
    margin: 0 auto;
  }

  h1 {
    margin: 0 0 24px;
    font-size: 28px;
  }

  h2 {
    margin: 32px 0 6px;
    font-size: 18px;
  }

  .sub {
    margin: 0 0 16px;
    color: var(--muted);
  }

  .key {
    display: grid;
    gap: 8px;
    padding: 14px 0;
    border-top: 1px solid var(--line);
  }

  .label {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    align-items: baseline;
  }

  .label span {
    color: var(--muted);
    font-size: 14px;
  }

  .plugin,
  .device {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 10px 0;
    border-top: 1px solid var(--line);
  }

  .plugin .label,
  .device .label {
    min-width: 0;
    margin-right: auto;
    overflow-wrap: anywhere;
  }

  .note {
    margin-top: 12px;
    font-size: 14px;
  }

  .row,
  .tv {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
  }

  input {
    flex: 1;
    min-width: 0;
    padding: 10px 16px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--card);
    color: var(--fg);
    outline: none;
  }

  input:focus-visible {
    border-color: var(--accent);
  }

  button {
    padding: 10px 18px;
    border-radius: 999px;
    font-weight: 600;
    cursor: pointer;
  }

  .primary {
    border: 0;
    background: var(--accent);
    color: #fff;
  }

  .quiet {
    border: 1px solid var(--line);
    background: none;
    color: var(--fg);
  }

  .danger {
    color: var(--danger);
  }

  button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .tv span {
    margin-right: auto;
    color: var(--muted);
  }

  /* The code is read aloud to whoever is typing it: spaced, and in the app's one monospace. */
  .code {
    margin-right: auto;
    font:
      700 20px/1.2 ui-monospace,
      SFMono-Regular,
      Menlo,
      Consolas,
      monospace;
    letter-spacing: 0.18em;
  }

  .error {
    color: var(--danger);
  }
</style>
