<!-- Settings › Connections › Assistants: the assistants (Claude, ChatGPT) connected to Den's MCP server, and revoking
     one. A member sees their library's, their guests' included; a guest sees their own. Revoking ends the connection
     at its next call. -->
<script lang="ts">
  import Confirm from './Confirm.svelte';
  import SettingRow from './SettingRow.svelte';
  import { fetchMcpUrl, listConnections, revokeConnection, type Connection } from '../lib/oauth';

  let connections = $state<Connection[] | null>(null);
  let mcpUrl = $state<string | null>(null);
  let problem = $state<string | null>(null);
  let copied = $state(false);

  const day = (at: number) =>
    new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  async function load() {
    const [listed, url] = await Promise.all([listConnections(), fetchMcpUrl()]);
    mcpUrl = url;
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

  async function revoke(connection: Connection) {
    const reply = await revokeConnection(connection.sid);
    if (reply.ok) connections = (connections ?? []).filter((c) => c.sid !== connection.sid);
    else problem = 'Couldn’t disconnect it. Try again in a moment.';
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      // No clipboard: the address is on screen to copy by hand.
    }
  }
</script>

<SettingRow
  id="assistants"
  label="Assistants"
  detail="Claude, ChatGPT and other MCP clients"
  value={connections?.length ? `${connections.length} connected` : ''}
>
  {#await load()}
    <p class="status" role="status">Loading…</p>
  {:then}
    {#if connections?.length}
      <ul class="list">
        {#each connections as connection (connection.sid)}
          <li class="line">
            <span class="label"
              >{connection.client}<small
                >{connection.guest
                  ? `Connected by ${connection.guest}`
                  : 'Connected by your library'} · since {day(connection.createdAt)} · last used {day(
                  connection.usedAt,
                )}</small
              ></span
            >
            <Confirm
              label="Disconnect"
              ariaLabel="Disconnect {connection.client}"
              question="Disconnect {connection.client}?"
              detail="It stops being able to search Den right away. It can be connected again."
              onconfirm={() => void revoke(connection)}
            />
          </li>
        {/each}
      </ul>
    {:else if !problem}
      <p class="status">No assistant is connected.</p>
    {/if}
    {#if problem}<p class="status bad" role="alert">{problem}</p>{/if}
    {#if mcpUrl}
      {@const address = mcpUrl}
      <h3>Connect one</h3>
      <span class="copy">
        <input class="field mono" readonly aria-label="Connector address" value={address} />
        <button type="button" class="quiet" onclick={() => void copy(address)}
          >{copied ? 'Copied' : 'Copy'}</button
        >
      </span>
      <p class="foot">
        In Claude or ChatGPT, add a custom connector with this address. You’ll be asked here to
        allow it. An assistant searches Den’s index and links you to titles here; it can’t see your
        library, watchlist or settings.
      </p>
    {/if}
  {/await}
</SettingRow>

<style>
  .copy {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
</style>
