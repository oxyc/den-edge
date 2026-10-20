<!-- "Use Den on your phone": a link and QR that bring a guest's library, and a slot in their grant, to another device.
     Shown for a guest's own library (`Link.guest`). It hosts a pairing (`pair.ts`, as linking a browser does) and puts
     the pairing code in the link's fragment with a device ticket: the library key is NOT in the link. The phone runs
     the pairing, this browser asks "Allow this phone?" before it hands the library over, and the key reaches the phone
     sealed. The link is good for the pairing session (ten minutes) and one phone. After the grant has ended the link
     carries no ticket and brings only the library. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import Button from '../components/Button.svelte';
  import SettingRow from './SettingRow.svelte';
  import { copyText } from '../lib/clipboard';
  import { thisDevice } from '../lib/device.svelte';
  import { deviceTicket } from '../lib/grants';
  import { guestGrants } from '../lib/grants.svelte';
  import { links } from '../lib/links.svelte';
  import { host, type HostError } from '../lib/pair';
  import { phoneLink } from '../lib/phoneLink';
  import { qrCode } from '../lib/qr';

  let {
    sealHandover,
    selfId,
  }: {
    sealHandover: (
      handoverKey: string,
      host: string,
      linkKey: string,
    ) => Promise<{ sealed: string; linkKey: string; inboxKey: string }>;
    selfId: string;
  } = $props();

  const link = $derived(links.current?.guest ? links.current : undefined);
  let made = $state<{ address: string; withAddons: boolean } | null>(null);
  let working = $state(false);
  let problem = $state<string | null>(null);
  let expired = $state(false);
  let joined = $state<string | null>(null);
  let asking = $state<string | null>(null);
  let answer = $state<((allowed: boolean) => void) | null>(null);
  let copied = $state(false);
  let manual = $state(false);
  let field = $state<HTMLInputElement>();
  const qr = $derived(made ? qrCode(made.address) : null);
  const shareable = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const failures: Record<HostError, string> = {
    unreachable: 'Couldn’t reach Den. Check your connection and try again.',
    busy: 'Too many links were made just now. Wait a minute and try again.',
    failed: 'That didn’t finish. Make a new link and try again.',
    insecure:
      'This needs a secure connection. Open Den over https (not a plain http address) and try again.',
  };

  /** Ends the pairing this page started when it goes, or when a new link replaces it. */
  let controller = new AbortController();
  let attempt = 0;
  onMount(() => () => {
    attempt++;
    controller.abort();
    answer?.(false);
  });

  async function make() {
    const current = links.current;
    if (!current?.guest) return;
    const mine = ++attempt;
    controller.abort();
    answer?.(false);
    controller = new AbortController();
    working = true;
    problem = null;
    expired = false;
    joined = null;
    made = null;
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
        problem = failures.unreachable;
        return;
      }
    }
    const result = await host({
      signal: controller.signal,
      seal: sealHandover,
      label: thisDevice.name,
      deviceId: selfId,
      onCode: (code) => {
        if (mine !== attempt) return;
        made = {
          address: phoneLink(__DEN_TV_PACKAGED__ ? __DEN_TV_API_ORIGIN__ : location.origin, {
            ticket,
            code,
          }),
          withAddons: ticket !== null,
        };
        working = false;
      },
      allow: (joiner) =>
        new Promise<boolean>((resolve) => {
          if (mine !== attempt) return resolve(false);
          asking = joiner;
          answer = (allowed) => {
            asking = null;
            answer = null;
            resolve(allowed);
          };
        }),
    });
    if (mine !== attempt) return;
    working = false;
    made = null;
    if ('joiner' in result) {
      links.share(result.joiner, current.libraryKey, {
        inboxKey: result.inboxKey,
        linkKey: btoa(String.fromCharCode(...result.linkKey)),
      });
      joined = result.joiner;
    } else if (result.error === 'failed') {
      // Ten minutes passed with no phone, or the phone was not allowed: either way the link no longer works.
      expired = true;
    } else {
      problem = failures[result.error];
    }
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
        the addons you were lent, if there is a device free for them. The link works once, for ten
        minutes, and asks you here before the phone gets anything.
      </p>
      {#if made && qr}
        <svg
          class="qr"
          viewBox="-2 -2 {qr.size + 4} {qr.size + 4}"
          role="img"
          aria-label="QR code to scan with your phone"
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
            ? 'Waiting for your phone. The addons in this link work for one device.'
            : 'Your access to shared addons has ended, so this link brings only your library.'}
        </p>
      {/if}
      {#if asking}
        <div class="ask" role="alertdialog" aria-label="Allow this phone?">
          <p><b>Allow {asking}?</b> It gets your library and watchlist.</p>
          <span class="copy">
            <Button variant="primary" label="Allow this phone" onclick={() => answer?.(true)} />
            <Button label="Don’t allow" onclick={() => answer?.(false)} />
          </span>
        </div>
      {/if}
      {#if joined}<p class="status" role="status">{joined} now has your library.</p>{/if}
      {#if expired}
        <p class="status bad" role="status">
          That link has expired or wasn’t used. Make a new one to try again.
        </p>
      {/if}
      {#if problem}<p class="status bad" role="status">{problem}</p>{/if}
      <Button
        variant="primary"
        label={working
          ? 'Making…'
          : made || expired || joined
            ? 'Make a new link'
            : 'Use Den on your phone'}
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

  .ask {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    border-radius: 12px;
    background: rgb(255 255 255 / 0.05);
  }

  .ask p b {
    color: var(--fg);
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
