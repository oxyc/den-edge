<!-- Settings, as on the TV: the user's own API keys and addons — kept in the library's settings (`set:keys`,
     `set:plugins`), sealed, so the TV and this browser share them and den-edge can't read them — and the linked TV. -->
<script lang="ts">
  import { loadLibrary } from './lib/backup';
  import { browserClock } from './lib/clock';
  import { links, type Link } from './lib/links.svelte';
  import { LibraryLog } from './lib/log';
  import { acceptsAddonURL, readApiKey, readPlugins } from './lib/prefs';
  import type { ConfigValue, SettingsRow } from './lib/wire';

  let { link }: { link: Link } = $props();

  const services = [
    { name: 'tmdb', label: 'TMDB', hint: 'Search, and every title’s poster and details.' },
    { name: 'omdb', label: 'OMDb', hint: 'IMDb, Rotten Tomatoes and Metacritic ratings.' },
    { name: 'doesthedogdie', label: 'DoesTheDogDie', hint: 'Content warnings.' },
  ];

  /** undefined while it opens; null when this browser can't reach the library. */
  let log = $state<LibraryLog | null | undefined>(undefined);
  /** Bumped after a write: the log isn't reactive. */
  let version = $state(0);
  let drafts = $state<Record<string, string>>(Object.fromEntries(services.map((s) => [s.name, ''])));
  let saving = $state(false);
  let failure = $state<string | null>(null);
  const clock = browserClock();

  $effect(() => {
    void open(link).then((opened) => (log = opened));
  });

  /** A paired link holds the library key; an older one finds it in the TV's backup. */
  async function open(link: Link): Promise<LibraryLog | null> {
    const backup = link.libraryKey ? undefined : await loadLibrary(link.inboxKey);
    const key = link.libraryKey ?? (backup?.state === 'ok' ? backup.libraryKey : undefined);
    if (!key) return null;
    const opened = await LibraryLog.open(key);
    if (opened) clock.see(opened.newestStamp());
    return opened;
  }

  const keys = $derived.by(() => {
    void version;
    return log?.settings('keys');
  });
  const plugins = $derived.by(() => {
    void version;
    return readPlugins(log?.settings('plugins'));
  });

  /** Set one setting, or clear it with null — stamped now, merged over what the TV last wrote. */
  async function write(group: string, name: string, value: ConfigValue | null): Promise<boolean> {
    if (!log) return false;
    saving = true;
    failure = null;
    const base: SettingsRow = log.settings(group) ?? { kind: 'set', schema: 2, name: group, values: {} };
    const row: SettingsRow = { ...base, values: { ...base.values, [name]: { value, at: clock.issue() } } };
    const saved = await log.write(row);
    saving = false;
    if (!saved) {
      failure = 'Couldn’t save that. Check that this device is on your network.';
      return false;
    }
    version++;
    return true;
  }

  async function save(name: string, value: string | null) {
    if (await write('keys', name, value ? { string: value } : null)) drafts[name] = '';
  }

  let addonDraft = $state('');
  /** Trailing slashes dropped, so the same addon typed twice is one entry. */
  const addonURL = $derived(addonDraft.trim().replace(/\/+$/, ''));

  async function addPlugin() {
    if (!acceptsAddonURL(addonURL)) {
      failure = 'Use https://, or http:// for an address on your network (localhost, *.local, 10.x, 172.16–31.x, 192.168.x).';
      return;
    }
    if (await write('plugins', addonURL, { bool: true })) addonDraft = '';
  }

  function hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  // Unlinking asks twice: a second press within a few seconds confirms, so a stray tap does nothing.
  let confirming = $state(false);
  function unlink() {
    if (!confirming) {
      confirming = true;
      setTimeout(() => (confirming = false), 4000);
      return;
    }
    links.remove(link.inboxKey);
    location.hash = '';
  }
</script>

<section>
  <h1>Settings</h1>

  <h2>Your keys</h2>
  <p class="sub">Your own API keys, shared with your Apple TV through your library. They’re sealed: den-edge can’t read them.</p>
  {#if log === undefined}
    <p class="sub">Loading…</p>
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
            <button type="button" class="quiet" disabled={saving} onclick={() => save(service.name, null)}>Remove</button>
          {/if}
        </div>
      </form>
    {/each}

    <h2>Plugins</h2>
    <p class="sub">Your addons, shared with your Apple TV through your library. One you add here waits on the TV until you install it there.</p>
    {#each plugins as url (url)}
      <div class="plugin">
        <span title={url}>{hostOf(url)}</span>
        <button class="quiet" disabled={saving} onclick={() => write('plugins', url, null)}>Remove</button>
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

  <h2>Apple TV</h2>
  <div class="tv">
    <span>Linked to {link.name ?? 'your Apple TV'}</span>
    <!-- The companion page's tools (sending to the TV) until they move here. It shares this link. -->
    <a class="tools glass" href="/app/">Companion tools</a>
    <button class="quiet danger" onclick={unlink}>{confirming ? 'Press again to unlink' : 'Unlink'}</button>
  </div>
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

  .plugin {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 10px 0;
    border-top: 1px solid var(--line);
  }

  .plugin span {
    margin-right: auto;
    overflow: hidden;
    text-overflow: ellipsis;
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

  button,
  .tools {
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

  .tools {
    color: var(--fg);
    text-decoration: none;
  }

  .error {
    color: var(--danger);
  }
</style>
