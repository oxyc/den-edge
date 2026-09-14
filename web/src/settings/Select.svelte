<!-- A single choice among many (a language, a country, a year floor) as the browser's own picker: typed into on a
     keyboard, the system wheel on a phone. Quiet, it sits in a row where the TV shows the chosen value; boxed, it's a
     field of its own. -->
<script lang="ts">
  type Option = { value: string; label: string };

  let {
    labelledby,
    label,
    value,
    options = [],
    groups = [],
    boxed = false,
    disabled = false,
    onchange,
  }: {
    labelledby?: string;
    label?: string;
    value: string;
    options?: readonly Option[];
    groups?: readonly { label: string; options: readonly Option[] }[];
    boxed?: boolean;
    disabled?: boolean;
    onchange: (value: string) => void;
  } = $props();
</script>

<select
  class:boxed
  aria-labelledby={labelledby}
  aria-label={label}
  {value}
  {disabled}
  onchange={(event) => onchange(event.currentTarget.value)}
>
  {#each options as option (option.value)}
    <option value={option.value}>{option.label}</option>
  {/each}
  {#each groups as group (group.label)}
    <optgroup label={group.label}>
      {#each group.options as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </optgroup>
  {/each}
</select>

<style>
  select {
    max-width: 58%;
    min-height: 40px;
    padding: 0 30px 0 10px;
    border: 0;
    border-radius: 10px;
    appearance: none;
    background: transparent
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%239a9aa6' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='m8 10 4 4 4-4'/%3E%3C/svg%3E")
      no-repeat right 6px center / 16px;
    color: var(--muted);
    font: inherit;
    text-align: right;
    text-align-last: right;
    text-overflow: ellipsis;
    cursor: pointer;
  }

  select:hover {
    background-color: rgb(255 255 255 / 0.06);
    color: var(--fg);
  }

  select:focus-visible {
    outline: 2px solid var(--accent);
  }

  select.boxed {
    flex: 1 1 240px;
    min-width: 0;
    max-width: none;
    min-height: 44px;
    padding: 0 36px 0 14px;
    background-color: rgb(255 255 255 / 0.06);
    background-position: right 10px center;
    color: var(--fg);
    font-size: 16px;
    text-align: left;
    text-align-last: left;
  }

  option,
  optgroup {
    background: var(--card);
    color: var(--fg);
    text-align: left;
  }

  select:disabled {
    opacity: 0.45;
    cursor: default;
  }

  @media (width < 760px) {
    select {
      max-width: 52%;
    }
  }
</style>
