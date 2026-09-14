<!-- A single choice among a few short options (subtitles per language, the parental limit), as radio buttons. -->
<script lang="ts" generics="T">
  let {
    name,
    labelledby,
    options,
    value,
    disabled = false,
    onchange,
  }: {
    /** The radio group's name, unique on the page. */
    name: string;
    labelledby: string;
    options: readonly { value: T; label: string }[];
    value: T;
    disabled?: boolean;
    onchange: (value: T) => void;
  } = $props();
</script>

<div class="segmented" role="radiogroup" aria-labelledby={labelledby}>
  {#each options as option, index (index)}
    <label>
      <input
        type="radio"
        {name}
        checked={option.value === value}
        {disabled}
        onchange={() => onchange(option.value)}
      />
      <span>{option.label}</span>
    </label>
  {/each}
</div>

<style>
  .segmented {
    display: flex;
    flex-shrink: 0;
    width: max-content;
    max-width: 100%;
    gap: 2px;
    padding: 3px;
    border-radius: 999px;
    background: rgb(255 255 255 / 0.06);
  }

  label {
    position: relative;
  }

  input {
    position: absolute;
    inset: 0;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }

  span {
    display: grid;
    place-items: center;
    min-width: 44px;
    min-height: 32px;
    padding: 0 12px;
    border-radius: 999px;
    color: var(--muted);
    font-size: 14px;
    font-weight: 600;
  }

  input:checked + span {
    background: rgb(255 255 255 / 0.14);
    color: var(--fg);
  }

  input:focus-visible + span {
    outline: 2px solid var(--accent);
  }

  input:disabled + span {
    opacity: 0.45;
  }

  @media (pointer: coarse) {
    span {
      min-height: 38px;
    }
  }
</style>
