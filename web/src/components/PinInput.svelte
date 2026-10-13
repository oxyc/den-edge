<script lang="ts">
  import { onMount } from 'svelte';
  import { profilePinInput } from '../lib/profilePin';

  let {
    id,
    label,
    value = $bindable(''),
    invalid = false,
    autocomplete = 'off',
    focusOnMount = false,
    engaged = true,
    onvalue = () => {},
    oncomplete = () => {},
  }: {
    id: string;
    label: string;
    value?: string;
    invalid?: boolean;
    autocomplete?: 'off' | 'new-password';
    focusOnMount?: boolean;
    engaged?: boolean;
    onvalue?: (value: string) => void;
    oncomplete?: (value: string) => void;
  } = $props();
  let input = $state<HTMLInputElement>();
  let focused = $state(false);

  onMount(() => {
    if (!focusOnMount) return;
    requestAnimationFrame(() => input?.focus({ preventScroll: true }));
  });

  function changed(event: Event) {
    const next = profilePinInput((event.currentTarget as HTMLInputElement).value);
    value = next.value;
    onvalue(value);
    if (next.complete) oncomplete(value);
  }
</script>

<div class="pin-entry">
  <label for={id}>{label}</label>
  <div class="pin-control" class:invalid>
    <input
      bind:this={input}
      {id}
      bind:value
      type="password"
      inputmode="numeric"
      {autocomplete}
      maxlength="4"
      pattern="[0-9][0-9][0-9][0-9]"
      aria-invalid={invalid}
      oninput={changed}
      onfocus={() => (focused = true)}
      onblur={() => (focused = false)}
    />
    <div class="pin-slots" aria-hidden="true">
      {#each [0, 1, 2, 3] as index (index)}
        <span
          class:active={focused && index === Math.min(value.length, 3)}
          class:filled={value.length > index}
          class:ready={engaged && index === Math.min(value.length, 3)}
          class="pin-slot"
          data-pin-slot>{value.length > index ? '•' : ''}</span
        >
      {/each}
    </div>
  </div>
</div>

<style>
  .pin-entry {
    display: grid;
    flex: 1 1 280px;
    gap: 8px;
    width: min(100%, 360px);
  }

  label {
    color: var(--muted);
    font-size: 14px;
    font-weight: 650;
  }

  .pin-control {
    position: relative;
    width: 100%;
    border-radius: 13px;
  }

  input {
    position: absolute;
    z-index: 1;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    opacity: 0.01;
    color: transparent;
    caret-color: transparent;
    cursor: text;
  }

  .pin-slots {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
  }

  .pin-slot {
    display: grid;
    place-items: center;
    min-height: 58px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: rgb(255 255 255 / 0.055);
    color: var(--fg);
    font-size: 27px;
    line-height: 1;
  }

  .pin-slot.filled {
    border-color: color-mix(in srgb, var(--accent) 40%, var(--line));
    background: rgb(255 255 255 / 0.09);
  }

  .pin-slot.ready {
    border-color: color-mix(in srgb, var(--accent) 72%, var(--line));
  }

  .pin-slot.active {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .pin-control.invalid .pin-slot {
    border-color: var(--bad, #ff9a9a);
    background: color-mix(in srgb, var(--bad, #ff9a9a) 7%, transparent);
  }

  .pin-slot.active:not(.filled)::after {
    width: 2px;
    height: 22px;
    border-radius: 999px;
    background: var(--accent);
    content: '';
    animation: pin-caret 1s step-end infinite;
  }

  @keyframes pin-caret {
    50% {
      opacity: 0;
    }
  }

  @media (width <= 420px) {
    .pin-slots {
      gap: 8px;
    }

    .pin-slot {
      min-height: 54px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .pin-slot.active:not(.filled)::after {
      animation: none;
    }
  }
</style>
