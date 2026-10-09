<!-- A destructive action that asks first, in place: the button gives way to the question with the action and Cancel, and
     focus goes to Cancel so a second press of Enter can't confirm by accident. The TV's `.confirmDelete`, without a
     modal. -->
<script lang="ts">
  import { tick } from 'svelte';
  import Button from '../components/Button.svelte';

  let {
    label,
    ariaLabel,
    question,
    detail,
    confirmLabel = label,
    disabled = false,
    tone = 'destructive',
    onconfirm,
  }: {
    label: string;
    /** A more specific name where several identical visible action labels share one list. */
    ariaLabel?: string;
    question: string;
    detail?: string;
    confirmLabel?: string;
    disabled?: boolean;
    tone?: 'destructive' | 'primary';
    onconfirm: () => void;
  } = $props();

  let asking = $state(false);
  let cancel = $state<HTMLButtonElement>();
  let trigger = $state<HTMLButtonElement>();

  async function ask() {
    asking = true;
    await tick();
    cancel?.focus();
  }

  async function dismiss() {
    asking = false;
    await tick();
    trigger?.focus();
  }
</script>

{#if asking}
  <!-- Escape from either button takes the question back. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="confirm"
    role="group"
    aria-label={question}
    onkeydown={(event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      void dismiss();
    }}
  >
    <p>
      <b>{question}</b>
      {detail ?? ''}
    </p>
    <span class="actions">
      <Button
        variant={tone}
        size="compact"
        label={confirmLabel}
        onclick={() => {
          asking = false;
          onconfirm();
        }}
      />
      <Button
        variant="secondary"
        size="compact"
        label="Cancel"
        bind:element={cancel}
        onclick={dismiss}
      />
    </span>
  </div>
{:else}
  <Button
    variant={tone}
    size="compact"
    {label}
    {disabled}
    {ariaLabel}
    bind:element={trigger}
    onclick={ask}
  />
{/if}

<style>
  .confirm {
    display: flex;
    flex-basis: 100%;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 12px;
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: rgb(255 255 255 / 0.03);
  }

  p {
    flex: 1 1 240px;
    margin: 0;
    color: var(--muted);
    font-size: 14px;
  }

  b {
    color: var(--fg);
  }

  .actions {
    display: flex;
    gap: 8px;
  }
</style>
