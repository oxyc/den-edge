<!-- Settings › Advanced, as on the TV. The TV's own look and backend (true black, a custom den-edge, seek previews)
     change how that TV draws and plays, so each TV keeps them and they're listed here only to say so; the away-from-home
     token is the library's, and entered here once. -->
<script lang="ts">
  import Confirm from './Confirm.svelte';
  import SettingRow from './SettingRow.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import { readApiKey } from '../lib/prefs';
  import type { ConfigValue, SettingsRow } from '../lib/wire';

  let {
    keys,
    disabled,
    selfId,
    pendingActions,
    edgeVersion,
    write,
  }: {
    keys: SettingsRow | undefined;
    disabled: boolean;
    selfId: string;
    /** Changes kept on this device, waiting to reach the library. */
    pendingActions: number;
    edgeVersion: string | null;
    write: (group: string, changes: Record<string, ConfigValue | null>) => Promise<boolean>;
  } = $props();

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
</script>

<SettingsSection id="advanced" title="Advanced">
  <h3 class="group">On each Apple TV</h3>
  <SettingRow id="oled" label="True black background (OLED)" value="Set on the TV" />
  <SettingRow id="custom-server" label="Use a custom server" value="Set on the TV" />
  <SettingRow id="seek-previews" label="Seek previews" value="Set on the TV" />
  <p class="foot">
    These change how an Apple TV draws and plays, so each TV keeps its own: Settings › Advanced on
    the TV.
  </p>

  <h3 class="group">Away from home</h3>
  <SettingRow
    id="away-from-home"
    label="Cloudflare Access token"
    value={hasAccess ? 'Saved' : 'Not set'}
  >
    <form
      class="form"
      onsubmit={(event) => {
        event.preventDefault();
        void saveAccess();
      }}
    >
      <input
        id="access-id"
        class="field"
        type="password"
        autocomplete="off"
        spellcheck="false"
        placeholder={hasAccess ? 'Client ID saved — type to replace' : 'Client ID'}
        aria-label="Access client ID"
        bind:value={accessId}
      />
      <input
        id="access-secret"
        class="field"
        type="password"
        autocomplete="off"
        spellcheck="false"
        placeholder={hasAccess ? 'Client secret saved — type to replace' : 'Client secret'}
        aria-label="Access client secret"
        bind:value={accessSecret}
      />
      <button class="primary" disabled={disabled || !accessId.trim() || !accessSecret.trim()}
        >Save</button
      >
      {#if hasAccess}
        <Confirm
          label="Remove"
          question="Remove the away-from-home token?"
          detail="Apple TVs in other homes stop reaching your plugins."
          {disabled}
          onconfirm={() => void saveAccess(true)}
        />
      {/if}
    </form>
    <p class="foot">
      The Cloudflare Access service token that lets an Apple TV in another home reach your plugins.
      Enter it once; it syncs through your library.
    </p>
  </SettingRow>

  <h3 class="group">Diagnostics</h3>
  <SettingRow id="diagnostics" label="Diagnostics">
    <dl class="facts">
      <div>
        <dt>Den</dt>
        <dd>{edgeVersion ? `den-edge ${edgeVersion}` : 'Checking…'}</dd>
      </div>
      <div>
        <dt>This browser</dt>
        <dd class="mono">{selfId}</dd>
      </div>
      <div>
        <dt>Waiting to sync</dt>
        <dd>
          {pendingActions
            ? `${pendingActions} change${pendingActions === 1 ? '' : 's'}`
            : 'Nothing'}
        </dd>
      </div>
    </dl>
    <p class="foot">
      The Apple TV’s own diagnostics — plugin health, recent log events, a report to share — are on
      the TV, under Settings › Advanced › Diagnostics.
    </p>
  </SettingRow>
</SettingsSection>

<style>
  .group {
    margin: 16px 0 2px 16px;
    color: var(--muted);
    font-size: 14px;
    font-weight: 600;
  }

  .group:first-of-type {
    margin-top: 0;
  }

  .facts {
    display: grid;
    margin: 8px 0 0;
  }

  .facts div {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 0;
    border-top: 1px solid var(--line);
    font-size: 15px;
  }

  .facts div:first-child {
    border-top: 0;
  }

  dd {
    margin: 0;
    color: var(--muted);
    text-align: right;
    overflow-wrap: anywhere;
  }
</style>
