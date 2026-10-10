<!-- An assistant asking to connect to Den (`/connect?request=…`, where den-edge's `/oauth/authorize` sends its person):
     who is asking, what it can do, and Allow or Deny. Only a browser that holds a library here, or a live invite to
     one, can allow it; den-edge checks that again, since this page is only where the question is asked. A browser
     that holds neither can link to a library right here, with the web app's own link screen, and then answer the
     same request: web storage is per address, so a library linked at another address of Den is not linked here.
     A member may also let it change the library (den-spec wire/assistant-v1.md): unticked unless they tick it. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { assistantLibrary } from '../lib/assistantLibrary.svelte';
  import { guestGrants } from '../lib/grants.svelte';
  import { links } from '../lib/links.svelte';
  import { answer, consentRequest, consentRequestId, type ConsentRequest } from '../lib/oauth';
  import { canProve, relayFetch } from '../lib/relayFetch';
  import { LinkScreen } from '../lib/screens.svelte';
  import Button from './Button.svelte';
  import ScreenLoading from './ScreenLoading.svelte';

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
  /** Changing the library is a member's to allow, for a request den-edge can grant it to. */
  const canWrite = $derived(!!request?.write && !!assistantLibrary.model);
  let allowWrite = $state(false);

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
    const model = allow && canWrite && allowWrite ? assistantLibrary.model : null;
    // The grant is written into the library before den-edge hears of it, so no request can reach a device first.
    let write: { grant: string; key: string } | undefined;
    if (model && request) {
      try {
        write = await model.consentAssistant(request.client);
      } catch (error) {
        console.error('den: an assistant grant could not be written', error);
        working = false;
        problem = 'Couldn’t save the permission in your library. Try again in a moment.';
        return;
      }
    }
    const result = await answer(id, allow, relayFetch, write);
    if (result.ok) {
      location.assign(result.value);
      return;
    }
    // Not approved: the grant written for it must never be usable.
    if (model && write)
      await model
        .revokeAssistant(write.grant)
        .catch((error: unknown) =>
          console.error('den: an unused assistant grant could not be revoked', error),
        );
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
    {#if canWrite}
      <label class="write">
        <input type="checkbox" bind:checked={allowWrite} disabled={working} />
        <span>
          Allow changes to my library
          <small
            >It can add to and remove from your watchlist, mark titles seen or unseen, and rate
            them. It still can’t see your library.</small
          >
        </span>
      </label>
    {/if}
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
        <ScreenLoading screen={LinkScreen} page={false} />
      {/if}
      <div class="actions">
        <Button label="Back" onclick={() => (linking = false)} />
      </div>
    {:else}
      <p>If someone invited you to their Den, open their invite in this browser instead.</p>
      <div class="actions">
        <Button
          variant="primary"
          label="Link this browser"
          disabled={!request || expired}
          onclick={startLinking}
        />
        <Button label="Close" onclick={close} />
      </div>
    {/if}
  {:else}
    <div class="actions">
      <Button
        variant="primary"
        label={working ? 'Connecting…' : 'Allow'}
        busy={working}
        disabled={!request || expired}
        onclick={() => void reply(true)}
      />
      {#if expired}
        <Button label="Close" onclick={close} />
      {:else}
        <Button label="Deny" disabled={working || !request} onclick={() => void reply(false)} />
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

  .write {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    margin: 0 0 16px;
    color: var(--fg);
    line-height: 1.45;
  }

  .write input {
    margin-top: 4px;
  }

  .write small {
    display: block;
    color: var(--muted);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 20px;
  }
</style>
