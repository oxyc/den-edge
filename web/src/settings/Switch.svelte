<!-- An on/off setting, as the TV's Toggle rows. -->
<script lang="ts">
  let {
    labelledby,
    checked,
    disabled = false,
    onchange,
  }: {
    labelledby: string;
    checked: boolean;
    disabled?: boolean;
    onchange: (on: boolean) => void;
  } = $props();
</script>

<input
  type="checkbox"
  role="switch"
  aria-labelledby={labelledby}
  {checked}
  {disabled}
  onchange={(event) => onchange(event.currentTarget.checked)}
/>

<style>
  input {
    position: relative;
    flex-shrink: 0;
    width: 46px;
    height: 28px;
    margin: 0;
    border-radius: 999px;
    appearance: none;
    background: #3a3a45;
    cursor: pointer;
    transition: background 0.15s;
  }

  input::after {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: #fff;
    content: '';
    transition: transform 0.15s;
  }

  input:checked {
    background: var(--accent);
  }

  input:checked::after {
    transform: translateX(18px);
  }

  input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  input:disabled {
    opacity: 0.45;
    cursor: default;
  }

  @media (prefers-reduced-motion: reduce) {
    input,
    input::after {
      transition: none;
    }
  }
</style>
