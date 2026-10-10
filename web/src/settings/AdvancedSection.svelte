<!-- Settings › Advanced, as on the TV. The TV's own look and backend (true black, a custom den-edge, seek previews)
     change how that TV draws and plays, so each TV keeps them and they're listed here only to say so; the away-from-home
     token is the library's, and entered here once. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Button from '../components/Button.svelte';
  import RecoveryRedeem from '../components/RecoveryRedeem.svelte';
  import Confirm from './Confirm.svelte';
  import SettingRow from './SettingRow.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import { libraryName } from './linkedDevices';
  import { links, type Link } from '../lib/links.svelte';
  import { navigate } from '../lib/navigation';

  let {
    link,
    onjoin,
    recovery,
    remoteAccessConfigured,
    disabled,
    selfId,
    pendingActions,
    edgeVersion,
    libraryFormat = null,
    setRemoteAccess,
  }: {
    /** Null for a browser using its own library, with no TV linked yet. */
    link: Link | null;
    /** For a browser using its own library: moves what it saved into the library a recovery code opens. */
    onjoin?: (libraryKey: string) => Promise<boolean>;
    /** The library's recovery code; none for a browser's own library. */
    recovery?: Snippet;
    remoteAccessConfigured: boolean;
    disabled: boolean;
    selfId: string;
    /** Changes kept on this device, waiting to reach the library. */
    pendingActions: number;
    edgeVersion: string | null;
    /** The library format reported by the service, when one is open. */
    libraryFormat?: number | null;
    setRemoteAccess: (
      credentials: { clientId: string; clientSecret: string } | null,
    ) => Promise<boolean>;
  } = $props();

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

  function unlink(target: Link) {
    links.remove(target.inboxKey);
    // The library this page was reading is gone; the app goes back to linking.
    if (target.inboxKey === link?.inboxKey) navigate('/');
  }

  let accessId = $state('');
  let accessSecret = $state('');
  const hasAccess = $derived(remoteAccessConfigured);

  /** Both halves together, or both cleared: one without the other opens nothing. */
  async function saveAccess(clear = false) {
    const [id, secret] = clear ? [null, null] : [accessId.trim(), accessSecret.trim()];
    if (!clear && (!id || !secret)) return;
    if (
      await setRemoteAccess(clear || !id || !secret ? null : { clientId: id, clientSecret: secret })
    ) {
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
      <Button
        type="submit"
        variant="primary"
        label="Save"
        disabled={disabled || !accessId.trim() || !accessSecret.trim()}
      />
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
      {#if libraryFormat !== null}
        <div>
          <dt>Library format</dt>
          <dd>v{libraryFormat}</dd>
        </div>
      {/if}
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

  <h3 class="group">This browser</h3>
  <SettingRow id="recovery" label="Recovery code" detail="Make one, or open a library with one">
    <h3>Open with a recovery code</h3>
    <RecoveryRedeem
      question={link
        ? 'This browser switches to that library. Your current library stays saved on this browser.'
        : 'What you’ve saved here moves into that library, and this browser uses it from then on.'}
      onopen={openRecovered}
    />
    {@render recovery?.()}
  </SettingRow>
  {#if links.list.length}
    <SettingRow id="sign-out" label="Sign out" detail="Libraries saved on this browser">
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
    </SettingRow>
  {/if}
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
