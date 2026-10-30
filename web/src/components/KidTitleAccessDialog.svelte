<script lang="ts">
  import { tick } from 'svelte';
  import type { Title } from '../lib/library';
  import Button from './Button.svelte';
  import PinInput from './PinInput.svelte';
  import { i18n } from '../lib/i18n.svelte';

  let {
    request,
    onconfirm,
    onclose,
  }: {
    request: { kid: { id: string; name: string }; title: Title; allow: boolean } | null;
    onconfirm: (pin: string) => Promise<boolean>;
    onclose: () => void;
  } = $props();
  let dialog = $state<HTMLDialogElement>();
  let pin = $state('');
  let busy = $state(false);
  let denied = $state(false);

  $effect(() => {
    if (request && !dialog?.open) {
      pin = '';
      denied = false;
      dialog?.showModal();
    } else if (!request && dialog?.open) dialog.close();
  });

  async function submit() {
    if (!/^\d{4}$/.test(pin) || busy) return;
    busy = true;
    denied = false;
    const saved = await onconfirm(pin);
    busy = false;
    pin = '';
    if (saved) close();
    else {
      denied = true;
      await tick();
      dialog?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    }
  }

  function close() {
    dialog?.close();
  }

  const heading = $derived(
    request
      ? i18n.format('actions.childAccessQuestion', '{action} for {name}?', {
          action: i18n.phrase(request.allow ? 'Allow' : 'Remove'),
          name: request.kid.name,
        })
      : '',
  );
  const detail = $derived(
    request
      ? request.allow
        ? i18n.format(
            'profile.allowTitleDetail',
            'This lets {name} open and play “{title}”, even when their content limit would block it.',
            { name: request.kid.name, title: request.title.title },
          )
        : i18n.format(
            'profile.removeTitleDetail',
            '{name} will follow their content limit for “{title}” again.',
            { name: request.kid.name, title: request.title.title },
          )
      : '',
  );
</script>

<dialog bind:this={dialog} aria-labelledby="kid-title-access-title" {onclose}>
  {#if request}
    <h2 id="kid-title-access-title">{heading}</h2>
    <p>{detail}</p>
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <PinInput
        id="kid-title-access-pin"
        label="Owner PIN"
        bind:value={pin}
        focusOnMount
        invalid={denied}
        onvalue={() => (denied = false)}
        oncomplete={() => void submit()}
      />
      {#if denied}<p class="bad" role="alert">
          That PIN didn’t match, or the change couldn’t be saved.
        </p>{/if}
      <div class="actions">
        <Button
          type="submit"
          variant="primary"
          label={busy ? 'Saving…' : request.allow ? 'Allow' : 'Remove'}
          {busy}
          disabled={busy || !/^\d{4}$/.test(pin)}
        />
        <Button label="Cancel" disabled={busy} onclick={close} />
      </div>
    </form>
  {/if}
</dialog>

<style>
  dialog {
    width: min(440px, calc(100vw - 2 * var(--gutter)));
    padding: 24px;
    border: 1px solid var(--line);
    border-radius: 16px;
    background: var(--card);
    color: var(--fg);
  }

  dialog::backdrop {
    background: rgb(0 0 0 / 0.6);
  }

  h2,
  p {
    margin: 0 0 12px;
  }

  p {
    color: var(--muted);
    line-height: 1.45;
  }

  form {
    display: grid;
    gap: 10px;
  }

  .bad {
    color: var(--danger);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
  }
</style>
