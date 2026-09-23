<!-- An assistant asking to connect to Den (`/connect?request=…`, where den-edge's `/oauth/authorize` sends its person):
     who is asking, what it can do, and Allow or Deny. Only a browser that holds a library here, or a live invite to
     one, can allow it; den-edge checks that again, since this page is only where the question is asked. A browser
     that holds neither can link to a library right here, with the web app's own link screen, and then answer the
     same request: web storage is per address, so a library linked at another address of Den is not linked here. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { guestGrants } from '../lib/grants.svelte';
  import { links } from '../lib/links.svelte';
  import { answer, consentRequest, consentRequestId, type ConsentRequest } from '../lib/oauth';
  import { canProve } from '../lib/relayFetch';
  import { LinkScreen } from '../lib/screens.svelte';

  let dialog = $state<HTMLDialogElement>();
  let id = $state<string | null>(null);
  let request = $state<ConsentRequest | null>(null);
  let working = $state(false);
  let problem = $state<string | null>(null);
  /** Whether the link screen is open in the dialog. */
  let linking = $state(false);
  /** den-edge has forgotten the request: nothing here can answer it any more. */
  let expired = $state(false);

  /** A browser that could say yes: linked to a library, or holding a live invite. */
  const eligible = $derived(!!links.current || guestGrants.list.some((grant) => !grant.ended));

  const failures: Record<string, string> = {
    request_expired:
      'This request has expired. Start connecting again from the assistant, and answer within ten minutes.',
    not_a_member:
      'Den didn’t recognise this browser as part of a library or an invite. Open the link in a browser linked to your Den.',
    unreachable: 'Couldn’t reach Den. Try again in a moment.',
  };

  function load(from: string) {
    void consentRequest(from).then((reply) => {
      if (reply.ok) request = reply.value;
      else {
        expired = reply.error === 'request_expired';
        problem = failures[reply.error] ?? failures.unreachable!;
      }
    });
  }

  onMount(() => {
    id = consentRequestId(location.href);
    if (!id) return;
    dialog?.showModal();
    load(id);
  });

  // Linked: back to the same request, asked again, since linking can outlast its ten minutes.
  $effect(() => {
    if (!linking || !eligible || !id) return;
    linking = false;
    problem = null;
    load(id);
  });

  function startLinking() {
    linking = true;
    void LinkScreen.load();
  }

  /** The library's proof arrives once it has opened, which may be a moment after this page did. */
  async function proofReady(): Promise<boolean> {
    for (let waited = 0; waited < 10_000 && !canProve(); waited += 100)
      await new Promise((resolve) => setTimeout(resolve, 100));
    return canProve();
  }

  async function reply(allow: boolean) {
    if (!id) return;
    working = true;
    problem = null;
    if (allow && !(await proofReady())) {
      working = false;
      problem = failures.not_a_member!;
      return;
    }
    const result = await answer(id, allow);
    if (result.ok) {
      location.assign(result.value);
      return;
    }
    working = false;
    problem = failures[result.error] ?? 'That didn’t work. Try again in a moment.';
  }

  function close() {
    dialog?.close();
  }
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="connect-title"
  onclose={() => {
    if (id) history.replaceState(history.state, '', '/');
    id = null;
  }}
>
  {#if request}
    {@const host = request.redirectHost ?? 'an unknown address'}
    <!-- Where the answer goes leads: a client names itself whatever it likes, so its name comes second and a
         known mark only for the hosts den-edge knows. -->
    <h2 id="connect-title">Connect {host} to Den?</h2>
    {#if request.verified}
      <p class="known">✓ A known assistant’s address</p>
    {:else}
      <p class="unknown" role="note">
        Den doesn’t know this address. Allow it only if you started connecting from <b>{host}</b>
        yourself, just now.
      </p>
    {/if}
    <p>
      It calls itself <b>“{request.client}”</b> and wants to search Den for you: find films, series and
      people in Den’s index, and link you to their pages here.
    </p>
    <p>
      It can’t see your library, watchlist or settings. You can disconnect it any time under
      Settings › Assistants.
    </p>
  {:else}
    <h2 id="connect-title">Connect an assistant to Den?</h2>
  {/if}
  {#if problem}<p role="alert" class="bad">{problem}</p>{/if}
  {#if !eligible}
    <p class="why">
      This browser isn’t linked to a Den library on this address. Link it to allow the connection.
    </p>
    {#if linking}
      <p>
        Get a code on your Apple TV under <b>Settings › Linked devices</b>, or in Den wherever your
        library is already open, under <b>Settings › Linked devices › Get a code</b>. Then type it
        here.
      </p>
      {#if LinkScreen.current}
        <LinkScreen.current embedded />
      {:else}
        <p role="status">Loading…</p>
      {/if}
      <div class="actions">
        <button type="button" class="quiet" onclick={() => (linking = false)}>Back</button>
      </div>
    {:else}
      <p>If someone invited you to their Den, open their invite in this browser instead.</p>
      <div class="actions">
        <button type="button" class="primary" disabled={!request || expired} onclick={startLinking}
          >Link this browser</button
        >
        <button type="button" class="quiet" onclick={close}>Close</button>
      </div>
    {/if}
  {:else}
    <div class="actions">
      <button
        type="button"
        class="primary"
        disabled={working || !request || expired}
        onclick={() => void reply(true)}>{working ? 'Connecting…' : 'Allow'}</button
      >
      {#if expired}
        <button type="button" class="quiet" onclick={close}>Close</button>
      {:else}
        <button
          type="button"
          class="quiet"
          disabled={working || !request}
          onclick={() => void reply(false)}>Deny</button
        >
      {/if}
    </div>
  {/if}
</dialog>

<style>
  dialog {
    width: min(460px, calc(100vw - 2 * var(--gutter)));
    padding: 24px;
    border: 1px solid var(--line);
    border-radius: 16px;
    background: var(--card);
    color: var(--fg);
  }

  dialog::backdrop {
    background: rgb(0 0 0 / 0.6);
  }

  h2 {
    margin: 0 0 8px;
    font-size: 20px;
  }

  p {
    margin: 0 0 16px;
    color: var(--muted);
    line-height: 1.45;
  }

  p b {
    color: var(--fg);
  }

  .bad {
    color: var(--danger);
  }

  .why,
  .known {
    color: var(--fg);
    font-weight: 600;
  }

  .unknown {
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    color: var(--fg);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 20px;
  }

  button {
    min-height: 44px;
    padding: 0 20px;
    border-radius: 999px;
    font-size: 15px;
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

  .quiet:hover {
    background: rgb(255 255 255 / 0.06);
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
