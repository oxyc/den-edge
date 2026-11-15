<!-- An assistant asking to connect to Den (`/connect?request=…`, where den-edge's `/oauth/authorize` sends its person):
     who is asking, what it can do, and Allow or Deny. Only a browser that holds a library here, or a live invite to
     one, can allow it; den-edge checks that again, since this page is only where the question is asked. A browser
     that holds neither can link to a library right here, with the web app's own link screen, and then answer the
     same request: web storage is per address, so a library linked at another address of Den is not linked here.
     A member may also let it change the library, and read the watchlist and history (den-spec
     wire/assistant-v1.md, §15): each its own checkbox, unticked unless they tick it. -->
<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { assistantLibrary } from '../lib/assistantLibrary.svelte';
  import type { AssistantLibraryAuthority } from '../lib/assistantLibrary.svelte';
  import { guestGrants } from '../lib/grants.svelte';
  import { i18n } from '../lib/i18n.svelte';
  import { links } from '../lib/links.svelte';
  import {
    answer,
    consentRequest,
    consentRequestId,
    type Approval,
    type ConsentRequest,
  } from '../lib/oauth';
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
  let operation = 0;
  let requestGeneration = 0;
  let activeAuthorityModel: AssistantLibraryAuthority['model'] | null = null;
  let awaitingInitialAuthority = false;
  type PendingCleanup = {
    authority: AssistantLibraryAuthority;
    grant: string;
    approvalProblem: string;
  };
  let pendingCleanup = $state.raw<PendingCleanup | null>(null);
  let allowButton = $state<HTMLButtonElement>();
  let retryCleanupButton = $state<HTMLButtonElement>();

  /** A browser that could say yes: linked to a library, or holding a live invite. */
  const eligible = $derived(!!links.current || guestGrants.list.some((grant) => !grant.ended));
  /** Changing the library is a member's to allow, for a request den-edge can grant it to. */
  const canWrite = $derived(!!request?.write && !!assistantLibrary.authority?.model);
  let allowWrite = $state(false);
  /** So is reading the watchlist and history. */
  const canRead = $derived(!!request?.read && !!assistantLibrary.authority?.model);
  let allowRead = $state(false);

  const failures: Record<string, string> = {
    request_expired:
      'This request has expired. Start connecting again from the assistant, and answer within ten minutes.',
    not_a_member:
      'Den didn’t recognise this browser as part of a library or an invite. Open the link in a browser linked to your Den.',
    unreachable: 'Couldn’t reach Den. Try again in a moment.',
  };

  function load(from: string) {
    const generation = ++requestGeneration;
    void consentRequest(from).then((reply) => {
      if (generation !== requestGeneration || id !== from) return;
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

  // Consent belongs to one exact model + membership proof. Replacement retires every old publication immediately;
  // a captured old model may still finish its private cleanup, but never writes into the replacement dialog.
  $effect(() => {
    const authority = assistantLibrary.authority;
    if ((authority?.model ?? null) === activeAuthorityModel) return;
    if (awaitingInitialAuthority && activeAuthorityModel === null && authority?.model) {
      activeAuthorityModel = authority.model;
      return;
    }
    activeAuthorityModel = authority?.model ?? null;
    const cleanup = untrack(() => pendingCleanup);
    ++operation;
    working = false;
    allowWrite = false;
    allowRead = false;
    if (cleanup?.authority.model !== authority?.model) pendingCleanup = null;
  });

  function startLinking() {
    linking = true;
    void LinkScreen.load();
  }

  /** The library's proof arrives once it has opened, which may be a moment after this page did. */
  async function proofReady(
    ticket: number,
    requestId: string,
    authority: AssistantLibraryAuthority | null,
  ): Promise<boolean> {
    for (
      let waited = 0;
      waited < 10_000 && owns(ticket, requestId, authority) && !canProve();
      waited += 100
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    return owns(ticket, requestId, authority) && canProve();
  }

  /** Linking can publish its member model just after the link itself becomes visible. Wait for that first exact
   * authority before fencing consent to it; later model replacement is still retired by `owns`. */
  async function initialAuthorityReady(
    requestId: string,
  ): Promise<AssistantLibraryAuthority | null> {
    for (let waited = 0; waited < 10_000 && id === requestId; waited += 100) {
      const authority = assistantLibrary.authority;
      if (authority && canProve()) return authority;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  const owns = (ticket: number, requestId: string, authority: AssistantLibraryAuthority | null) =>
    ticket === operation &&
    id === requestId &&
    assistantLibrary.authority?.model === authority?.model;

  async function cleanGrant(cleanup: PendingCleanup): Promise<boolean> {
    try {
      await cleanup.authority.model.revokeAssistant(cleanup.grant);
    } catch (error) {
      // A lost task reply is ambiguous: the durable rows may already be revoked. Read those rows directly before
      // asking the person to retry, without trusting this device's private refusal journal.
      console.warn('den: an unused assistant grant revocation needs durable readback', error);
    }
    try {
      return (
        (await cleanup.authority.model.assistantRevocationReadback(cleanup.grant)) !== 'unverified'
      );
    } catch (error) {
      console.error('den: an unused assistant grant could not be durably verified', error);
      return false;
    }
  }

  async function retryCleanup() {
    const cleanup = pendingCleanup;
    const requestId = id;
    if (!cleanup || !requestId || working) return;
    const ticket = ++operation;
    working = true;
    const cleaned = await cleanGrant(cleanup);
    if (!owns(ticket, requestId, cleanup.authority) || pendingCleanup !== cleanup) return;
    working = false;
    if (cleaned) {
      pendingCleanup = null;
      problem = cleanup.approvalProblem;
      await tick();
      if (owns(ticket, requestId, cleanup.authority)) allowButton?.focus();
    } else {
      problem = 'The connection failed and its library permission may remain. Retry cleanup.';
    }
  }

  async function reply(allow: boolean) {
    const requestId = id;
    if (!requestId || working || pendingCleanup) return;
    let authority = assistantLibrary.authority;
    const ticket = ++operation;
    working = true;
    problem = null;
    if (allow && !authority && links.current) {
      awaitingInitialAuthority = true;
      authority = await initialAuthorityReady(requestId);
      awaitingInitialAuthority = false;
      if (!authority || id !== requestId || !working) {
        working = false;
        problem = failures.not_a_member!;
        return;
      }
    }
    if (allow && !(await proofReady(ticket, requestId, authority))) {
      if (!owns(ticket, requestId, authority)) return;
      working = false;
      problem = failures.not_a_member!;
      return;
    }
    const write = allow && canWrite && allowWrite;
    const read = allow && canRead && allowRead;
    const model = write || read ? authority?.model : null;
    // The grant and read record are written into the library before den-edge hears of them, so no request can reach
    // a device, and no projection be read, before the library records what allows it.
    let approval: Approval | undefined;
    let grant: string | undefined;
    if (model && request) {
      try {
        const keys = await model.consentAssistant(request.client, { write, read });
        if (!owns(ticket, requestId, authority)) {
          await cleanGrant({
            authority: authority!,
            grant: keys.grant,
            approvalProblem: failures.unreachable!,
          });
          return;
        }
        grant = keys.grant;
        approval = {
          ...(write ? { write: { grant: keys.grant, key: keys.key } } : {}),
          ...(read && keys.readKey
            ? { read: { grant: keys.grant, key: keys.key, readKey: keys.readKey } }
            : {}),
        };
      } catch (error) {
        if (!owns(ticket, requestId, authority)) return;
        console.error('den: an assistant grant could not be written', error);
        working = false;
        problem = 'Couldn’t save the permission in your library. Try again in a moment.';
        return;
      }
    }
    if (!owns(ticket, requestId, authority)) return;
    // Approved for the library the rows were written to: on a split household, as the household's member.
    const result = await answer(requestId, allow, authority?.fetch ?? relayFetch, approval);
    if (!owns(ticket, requestId, authority)) {
      if (authority && grant)
        await cleanGrant({ authority, grant, approvalProblem: failures.unreachable! });
      return;
    }
    if (result.ok) {
      location.assign(result.value);
      return;
    }
    // Not approved: the grant and read record written for it must never be usable.
    const approvalProblem = failures[result.error] ?? 'That didn’t work. Try again in a moment.';
    if (authority && model && grant) {
      const cleanup = { authority, grant, approvalProblem };
      if (!(await cleanGrant(cleanup))) {
        if (!owns(ticket, requestId, authority)) return;
        pendingCleanup = cleanup;
        working = false;
        problem = 'The connection failed and its library permission may remain. Retry cleanup.';
        await tick();
        if (owns(ticket, requestId, authority) && pendingCleanup === cleanup)
          retryCleanupButton?.focus();
        return;
      }
    }
    if (!owns(ticket, requestId, authority)) return;
    working = false;
    problem = approvalProblem;
  }

  function close() {
    ++operation;
    ++requestGeneration;
    pendingCleanup = null;
    dialog?.close();
  }
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="connect-title"
  oncancel={(event) => {
    if (!pendingCleanup) return;
    event.preventDefault();
    retryCleanupButton?.focus();
  }}
  onclose={() => {
    ++operation;
    ++requestGeneration;
    working = false;
    pendingCleanup = null;
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
      {allowRead
        ? 'It can’t see your settings, accounts or devices.'
        : 'It can’t see your library, watchlist or settings.'} You can disconnect it any time under Settings
      › Assistants.
    </p>
    {#if canWrite}
      <label class="write">
        <input type="checkbox" bind:checked={allowWrite} disabled={working} />
        <span>
          Allow changes to my library and playing on my TV
          <small
            >It can add to and remove from your watchlist, mark titles seen or unseen, and rate
            them, and play a title or its trailer on your TV while Den is open there.{#if !allowRead}
              It still can’t see your library.{/if}</small
          >
        </span>
      </label>
    {/if}
    {#if canRead}
      <label class="write">
        <input type="checkbox" bind:checked={allowRead} disabled={working} />
        <span>
          Allow reading my watchlist and history
          <small
            >It can see your watchlist, what you’re in the middle of, and what you’ve watched, as of
            when Den last had it open. Never your settings, accounts or devices.</small
          >
        </span>
      </label>
    {/if}
  {:else}
    <h2 id="connect-title">Connect an assistant to Den?</h2>
  {/if}
  {#if problem}<p role="alert" class="bad">{i18n.phrase(problem)}</p>{/if}
  {#if pendingCleanup}
    <div class="actions">
      <Button
        bind:element={retryCleanupButton}
        variant="primary"
        label={working ? i18n.phrase('Trying again…') : i18n.phrase('Retry cleanup')}
        busy={working}
        disabled={working}
        onclick={() => void retryCleanup()}
      />
    </div>
  {/if}
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
  {:else if !pendingCleanup}
    <div class="actions">
      <Button
        bind:element={allowButton}
        variant="primary"
        label={working ? 'Connecting…' : 'Allow'}
        busy={working}
        disabled={!request || expired || !!pendingCleanup}
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
