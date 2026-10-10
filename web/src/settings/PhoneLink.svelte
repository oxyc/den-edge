<!-- "Use Den on your phone": a link and QR that bring a guest's library, and a slot in their grant, to another device.
     Shown for a guest's own library (`Link.guest`). The library key travels in the link's fragment, which no server
     reads (`phoneLink.ts`); the ticket in it is made by den-edge for one device and ten minutes, and takes a slot
     only when the phone opens the link. After the grant ends the link still brings the library, without addons. -->
<script lang="ts">
  import Button from '../components/Button.svelte';
  import SettingRow from './SettingRow.svelte';
  import { copyText } from '../lib/clipboard';
  import { deviceTicket } from '../lib/grants';
  import { guestGrants } from '../lib/grants.svelte';
  import { links } from '../lib/links.svelte';
  import { phoneLink } from '../lib/phoneLink';
  import { qrCode } from '../lib/qr';

  const link = $derived(links.current?.guest ? links.current : undefined);
  let made = $state<{ address: string; withAddons: boolean } | null>(null);
  let working = $state(false);
  let problem = $state<string | null>(null);
  let copied = $state(false);
  let manual = $state(false);
  let field = $state<HTMLInputElement>();
  const qr = $derived(made ? qrCode(made.address) : null);
  const shareable = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  async function make() {
    if (!link) return;
    working = true;
    problem = null;
    copied = false;
    manual = false;
    const grant = guestGrants.list.find((g) => !g.ended && g.secret);
    let ticket: string | null = null;
    if (grant) {
      const reply = await deviceTicket(grant.gid, grant.secret);
      if (reply.ok) ticket = reply.value.ticket;
      // The grant ended since this page last asked: the library still comes along, the host's addons do not.
      else if (reply.status !== 404 && reply.status !== 410) {
        working = false;
        problem = 'Couldn’t reach Den. Check your connection and try again.';
        return;
      }
    }
    made = {
      address: phoneLink(location.origin, { ticket, libraryKey: link.libraryKey }),
      withAddons: ticket !== null,
    };
    working = false;
  }

  async function copy(address: string) {
    const result = await copyText(address, () => field?.select());
    copied = result === 'copied';
    manual = result === 'manual';
  }
</script>

{#if link}
  <SettingRow
    id="phone"
    label="Use Den on your phone"
    detail="Bring your library and watchlist over"
  >
    <div class="form">
      <p>
        Open the link on your phone, or scan the code with it: your library comes over, and so do
        the addons you were lent, if there is a device free for them. Nothing to type. The link
        holds your whole library, so keep it to yourself.
      </p>
      {#if made && qr}
        <svg
          class="qr"
          viewBox="-2 -2 {qr.size + 4} {qr.size + 4}"
          role="img"
          aria-label="QR code for the phone link"
          shape-rendering="crispEdges"
        >
          <rect x="-2" y="-2" width={qr.size + 4} height={qr.size + 4} fill="#fff" />
          <path d={qr.path} fill="#000" />
        </svg>
        <span class="copy">
          <input
            class="field mono"
            readonly
            aria-label="Phone link"
            value={made.address}
            bind:this={field}
          />
          <Button
            variant="secondary"
            label={copied ? 'Copied' : 'Copy link'}
            onclick={() => void copy(made!.address)}
          />
          {#if shareable}
            <Button
              variant="secondary"
              label="Share"
              onclick={() => void navigator.share({ url: made!.address }).catch(() => undefined)}
            />
          {/if}
        </span>
        {#if manual}<p class="status" role="status">Select and copy the link.</p>{/if}
        <p class="status" role="status">
          {made.withAddons
            ? 'The addons in this link work for ten minutes and one device.'
            : 'Your access to shared addons has ended, so this link brings only your library.'}
        </p>
      {/if}
      {#if problem}<p class="status bad" role="status">{problem}</p>{/if}
      <Button
        variant="primary"
        label={working ? 'Making…' : made ? 'Make a new link' : 'Use Den on your phone'}
        busy={working}
        onclick={() => void make()}
      />
    </div>
  </SettingRow>
{/if}

<style>
  .form {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
    margin-top: 12px;
  }

  p {
    margin: 0;
    color: var(--muted);
    font-size: 14px;
  }

  .bad {
    color: var(--danger);
  }

  .qr {
    width: 200px;
    height: 200px;
    border-radius: 8px;
  }

  .copy {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-self: stretch;
  }

  .field {
    flex: 1 1 220px;
    min-width: 0;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: transparent;
    color: var(--fg);
    font-size: 13px;
  }

  .mono {
    font-family: ui-monospace, monospace;
  }
</style>
