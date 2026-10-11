<!-- Settings › Assistants: Den's MCP connector (oxyc/den#25). The address to give Claude or ChatGPT, how to add it there,
     and the assistants connected, each with Disconnect. A member sees their library's connections, their guests'
     included; a guest sees their own. Disconnecting ends a connection at its next call; one allowed to change the
     library also has its grant revoked in the library, which every device enforces (den-spec wire/assistant-v1.md). -->
<script lang="ts">
  import Button from '../components/Button.svelte';
  import Confirm from './Confirm.svelte';
  import SettingRow from './SettingRow.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import { copyText } from '../lib/clipboard';
  import { fetchMcpUrl, listConnections, revokeConnection, type Connection } from '../lib/oauth';
  import type { AssistantGrantView } from '../lib/libraryServiceProtocol';

  let {
    revokeGrant,
    listGrants,
  }: {
    /** Marks a grant revoked in the open library; absent where no member library is open here. */
    revokeGrant?: (grant: string) => Promise<unknown>;
    /** The grants the open library holds, whatever their state; absent where no member library is open here. */
    listGrants?: () => Promise<AssistantGrantView[]>;
  } = $props();

  /** The library's own record of who may change it: what every device enforces, whatever den-edge lists. */
  let grants = $state<AssistantGrantView[] | null>(null);

  async function loadGrants() {
    if (!listGrants) return;
    try {
      grants = await listGrants();
    } catch (error) {
      console.error('den: assistant grants could not be listed', error);
      grants = [];
    }
  }
  void loadGrants();

  const grantState = (grant: AssistantGrantView) => {
    switch (grant.state) {
      case 'active':
        return grant.expiresAt ? `can change your library until ${day(grant.expiresAt)}` : 'active';
      case 'expired':
        return 'expired';
      case 'revoked':
        return grant.revokedAt ? `revoked ${day(grant.revokedAt)}` : 'revoked';
      case 'newer':
        return 'made by a newer Den';
      case 'malformed':
        return 'unreadable';
    }
  };

  /** Revoke a grant from the library's list, and end any connection den-edge still holds for it. */
  async function revokeListed(grant: AssistantGrantView) {
    try {
      await revokeGrant?.(grant.grant);
    } catch (error) {
      console.error('den: an assistant grant could not be revoked', error);
      problem = 'Couldn’t revoke it. Try again in a moment.';
      return;
    }
    for (const connection of (connections ?? []).filter((c) => c.grant === grant.grant)) {
      const reply = await revokeConnection(connection.sid);
      if (reply.ok) connections = (connections ?? []).filter((c) => c.sid !== connection.sid);
    }
    await loadGrants();
  }

  /** The connector's address; null while it is off on this server, undefined until known or when Den can't be asked. */
  let mcpUrl = $state<string | null | undefined>(undefined);
  let asked = $state(false);
  let connections = $state<Connection[] | null>(null);
  let problem = $state<string | null>(null);
  let copied = $state(false);
  let manual = $state(false);
  let addressField = $state<HTMLInputElement>();

  const day = (at: number) =>
    new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  async function load() {
    mcpUrl = await fetchMcpUrl();
    asked = true;
    if (!mcpUrl) return;
    const listed = await listConnections();
    if (listed.ok) {
      connections = listed.value;
      problem = null;
    } else {
      connections = [];
      problem =
        listed.status === 403
          ? 'Link this browser to your library, or accept an invite, to see its assistants.'
          : 'Couldn’t reach Den. Try again in a moment.';
    }
  }
  void load();

  async function revoke(connection: Connection) {
    if (connection.grant) {
      // The grant first: what den-edge cannot undo, and what stops requests already queued.
      try {
        if (!revokeGrant) throw new Error('no library is open to revoke the grant in');
        await revokeGrant(connection.grant);
      } catch (error) {
        console.error('den: an assistant grant could not be revoked', error);
        problem = 'Couldn’t disconnect it. Try again in a moment.';
        return;
      }
    }
    const reply = await revokeConnection(connection.sid);
    if (reply.ok) connections = (connections ?? []).filter((c) => c.sid !== connection.sid);
    else problem = 'Couldn’t disconnect it. Try again in a moment.';
    if (connection.grant) await loadGrants();
  }

  async function copy(text: string) {
    const result = await copyText(text, () => addressField?.select());
    copied = result === 'copied';
    manual = result === 'manual';
  }

  const connectorValue = $derived(
    !asked
      ? 'Checking…'
      : mcpUrl === null
        ? 'Not enabled on this server'
        : mcpUrl === undefined
          ? 'Couldn’t reach Den'
          : '',
  );
</script>

<SettingsSection id="assistants" title="Assistants" subtitle="MCP connector for Claude and ChatGPT">
  {#if mcpUrl}
    {@const address = mcpUrl}
    <SettingRow id="assistant-connector" label="Connector address" detail={address}>
      <span class="copy">
        <input
          class="field mono"
          readonly
          aria-label="Connector address"
          value={address}
          bind:this={addressField}
        />
        <Button
          variant="secondary"
          label={copied ? 'Copied' : 'Copy'}
          onclick={() => void copy(address)}
        />
      </span>
      {#if manual}<p class="status" role="status">Select and copy the address.</p>{/if}
      <h3>Claude</h3>
      <ol class="steps">
        <li>Settings › Connectors › Add custom connector.</li>
        <li>Paste the address above and add it.</li>
        <li>Claude opens Den: choose Allow.</li>
      </ol>
      <h3>ChatGPT</h3>
      <ol class="steps">
        <li>Settings › Connectors (with developer mode on) › Create a custom connector.</li>
        <li>Paste the address above and create it.</li>
        <li>ChatGPT opens Den: choose Allow.</li>
      </ol>
      <p class="foot">
        An assistant can search Den’s titles and people, filter them and find ones like others, and
        links you to each title here. If you allow it when connecting, it can also change your
        library: add to or remove from your watchlist, mark titles seen or unseen, and rate them. It
        can’t see your library, watchlist or watch history either way, and gets nothing from TMDB.
      </p>
    </SettingRow>

    <SettingRow
      id="assistant-connections"
      label="Connected assistants"
      value={connections === null
        ? ''
        : connections.length
          ? `${connections.length} connected`
          : 'None'}
    >
      {#if connections?.length}
        <ul class="list">
          {#each connections as connection (connection.sid)}
            <li class="line">
              <span class="label"
                >{connection.client}{#if connection.redirectHost}<small
                    >{connection.redirectHost}</small
                  >{/if}<small
                  >{connection.kind === 'guest'
                    ? `Guest${connection.guest ? ` · ${connection.guest}` : ''}`
                    : 'Member'} · {connection.grant ? 'can change your library' : 'search only'} · connected
                  {day(connection.createdAt)} · last used {day(connection.usedAt)}</small
                ></span
              >
              <Confirm
                label="Disconnect"
                ariaLabel="Disconnect {connection.client}"
                question="Disconnect {connection.client}?"
                detail={connection.grant
                  ? 'It stops being able to search Den or change your library right away, and nothing it already asked for is applied. It can be connected again.'
                  : 'It stops being able to search Den right away. It can be connected again.'}
                onconfirm={() => void revoke(connection)}
              />
            </li>
          {/each}
        </ul>
      {:else if connections && !problem}
        <p class="status">No assistant is connected.</p>
      {/if}
      {#if problem}<p class="status bad" role="alert">{problem}</p>{/if}
    </SettingRow>
  {:else}
    <SettingRow id="assistant-connector" label="Connector" value={connectorValue} />
  {/if}
  {#if grants?.length}
    {@const active = grants.filter((g) => g.state === 'active').length}
    <SettingRow
      id="assistant-grants"
      label="Allowed to change your library"
      value={active ? `${active} allowed` : 'None'}
    >
      <ul class="list">
        {#each grants as grant (grant.grant)}
          <li class="line">
            <span class="label"
              >{grant.client ?? 'An assistant'}<small
                >{grantState(grant)}{#if grant.createdAt}
                  · allowed {day(grant.createdAt)}{/if}</small
              ></span
            >
            {#if grant.state !== 'revoked' && revokeGrant}
              <Confirm
                label="Revoke"
                ariaLabel="Revoke {grant.client ?? 'this assistant'}"
                question="Stop {grant.client ?? 'this assistant'} changing your library?"
                detail="Your devices refuse anything it asks for from now on, including what is still waiting. It can be allowed again by connecting it again."
                onconfirm={() => void revokeListed(grant)}
              />
            {/if}
          </li>
        {/each}
      </ul>
    </SettingRow>
  {/if}
</SettingsSection>

<style>
  .copy {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .steps {
    margin: 4px 0 0;
    padding-left: 20px;
    color: var(--muted);
    font-size: 14px;
  }
</style>
