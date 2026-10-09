<!-- An invite link, answered where it lands: one question, Accept or Not now. It used to open Settings › Sharing with
     the code filled in, which a first-time guest reached through the "Link your Apple TV" section above it — the
     one thing a guest has no use for. -->
<script lang="ts">
  import { guestGrants, type RedeemFailure } from '../lib/grants.svelte';
  import Button from './Button.svelte';

  const failures: Record<RedeemFailure, string> = {
    malformed: 'That link doesn’t carry a whole invite. Ask for it again.',
    invalid:
      'That invite didn’t work. It may have expired, been used up or been withdrawn: ask for a new one.',
    throttled: 'Too many tries. Wait a minute and try again.',
    unreachable: 'Couldn’t reach Den. Try again in a moment.',
  };

  let dialog = $state<HTMLDialogElement>();
  let code = $state<string | null>(null);
  let working = $state(false);
  let failure = $state<string | null>(null);

  // Taken once: the code leaves the shared state as soon as it is shown, so Settings doesn't ask the same question.
  $effect(() => {
    const invited = guestGrants.invite;
    if (!invited) return;
    code = invited;
    failure = null;
    guestGrants.invite = null;
    if (!dialog?.open) dialog?.showModal();
  });

  // An accepted invite just closes the dialog: the addons it lends are what shows it worked. Only a failure stays
  // open, to say why and offer another try.
  async function accept() {
    if (!code) return;
    working = true;
    const result = await guestGrants.redeem(code);
    working = false;
    if (typeof result === 'string') failure = failures[result];
    else close();
  }

  function close() {
    dialog?.close();
  }
</script>

<dialog bind:this={dialog} aria-labelledby="invite-title" onclose={() => (code = null)}>
  <h2 id="invite-title">Accept this invite?</h2>
  {#if failure}
    <p role="status" class="bad">{failure}</p>
    <div class="actions">
      <Button
        variant="primary"
        label={working ? 'Checking…' : 'Try again'}
        busy={working}
        onclick={() => void accept()}
      />
      <Button label="Close" onclick={close} />
    </div>
  {:else}
    <p>
      Someone shared their Den addons with you. Accepting lets this browser use them to find and
      play things. You can leave it any time under Settings › Sharing.
    </p>
    <div class="actions">
      <Button
        variant="primary"
        label={working ? 'Checking…' : 'Accept'}
        busy={working}
        onclick={() => void accept()}
      />
      <Button label="Not now" disabled={working} onclick={close} />
    </div>
  {/if}
</dialog>

<style>
  dialog {
    width: min(420px, calc(100vw - 2 * var(--gutter)));
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
    margin: 0 0 20px;
    color: var(--muted);
    line-height: 1.45;
  }

  .bad {
    color: var(--danger);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
</style>
