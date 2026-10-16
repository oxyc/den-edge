<!-- A "Use Den on your phone" link, answered where it lands: the guest's library comes to this phone, and so does the
     host's addons if the grant has a slot for it. Nothing to type and nothing to accept; the dialog says what happened. -->
<script lang="ts">
  import { phoneLanding } from '../lib/phoneLanding.svelte';
  import Button from './Button.svelte';

  let dialog = $state<HTMLDialogElement>();

  $effect(() => {
    if (phoneLanding.request && !dialog?.open) dialog?.showModal();
  });

  const addonLine = $derived.by(() => {
    switch (phoneLanding.addons) {
      case 'granted':
        return 'Your shared addons are on this phone too.';
      case 'full':
        return 'Your shared addons aren’t: as many devices as allowed are already using them. Ask for another device, then open the link again.';
      case 'expired':
        return 'The access to shared addons in that link has lapsed. Make a new link on your laptop to add it.';
      default:
        return '';
    }
  });

  function open() {
    phoneLanding.dismiss();
    location.assign('/');
  }
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="phone-title"
  oncancel={(event) => phoneLanding.phase !== 'done' && event.preventDefault()}
>
  {#if phoneLanding.phase === 'done'}
    <h2 id="phone-title">Your library is on this phone</h2>
    <p role="status">
      {#if phoneLanding.library === 'kept'}
        This browser already had a library of its own, so it keeps that one.
      {:else}
        What you saved on your laptop is here.
      {/if}
      {addonLine}
    </p>
    <div class="actions">
      <Button variant="primary" label="Open Den" onclick={open} />
    </div>
  {:else if phoneLanding.phase === 'failed'}
    <h2 id="phone-title">Couldn’t finish</h2>
    <p role="status" class="bad">{phoneLanding.problem}</p>
    <div class="actions">
      {#if phoneLanding.retryable}
        <Button variant="primary" label="Try again" onclick={() => phoneLanding.retry()} />
      {/if}
      <Button
        variant={phoneLanding.retryable ? 'secondary' : 'primary'}
        label={phoneLanding.retryable ? 'Not now' : 'Close'}
        onclick={() => phoneLanding.dismiss()}
      />
    </div>
  {:else}
    <h2 id="phone-title">Setting up Den on this phone</h2>
    <p role="status">
      Waiting for your laptop to allow this phone, then bringing your library over…
    </p>
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
