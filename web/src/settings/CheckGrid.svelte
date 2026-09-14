<!-- A list the TV draws as one row per option, as a grid of checkboxes: a hide list (HideRow) dims what's hidden and
     marks it with an eye-slash, a pick list (SelectRow) marks what's picked with a checkmark. -->
<script lang="ts" generics="T extends string | number">
  let {
    legend,
    options,
    checked,
    hide = false,
    disabled = false,
    wide = false,
    onchange,
  }: {
    legend: string;
    options: readonly { value: T; label: string; note?: string; disabled?: boolean }[];
    checked: (value: T) => boolean;
    /** A hide list: what's checked is hidden. */
    hide?: boolean;
    disabled?: boolean;
    /** Longer labels, fewer columns: service names. */
    wide?: boolean;
    onchange: (value: T, on: boolean) => void;
  } = $props();
</script>

<fieldset>
  <legend>{legend}</legend>
  <div class="grid" class:wide>
    {#each options as option (option.value)}
      <label class="check" class:hide>
        <input
          type="checkbox"
          checked={checked(option.value)}
          disabled={disabled || option.disabled}
          onchange={(event) => onchange(option.value, event.currentTarget.checked)}
        />
        <span class="name"
          >{option.label}{#if option.note}
            <small>{option.note}</small>{/if}</span
        >
        <svg class="mark" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          {#if hide}
            <path
              d="M3 12s3.5-6 9-6c1.6 0 3 .5 4.2 1.2M21 12s-3.5 6-9 6c-1.6 0-3-.5-4.2-1.2M4 4l16 16"
            />
          {:else}
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          {/if}
        </svg>
      </label>
    {/each}
  </div>
</fieldset>

<style>
  fieldset {
    margin: 0;
    padding: 0;
    border: 0;
  }

  legend {
    margin: 16px 0 6px;
    padding: 0;
    color: var(--muted);
    font-size: 14px;
    font-weight: 600;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(165px, 1fr));
    gap: 2px 8px;
  }

  .grid.wide {
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  }

  .check {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 6px 10px;
    border-radius: 10px;
    font-size: 15px;
    cursor: pointer;
  }

  .check:hover {
    background: rgb(255 255 255 / 0.06);
  }

  input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }

  .check:has(input:focus-visible) {
    outline: 2px solid var(--accent);
  }

  .mark {
    flex-shrink: 0;
    margin-left: auto;
    visibility: hidden;
    fill: none;
    stroke: currentcolor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .check:has(input:checked) .mark {
    visibility: visible;
  }

  .hide:has(input:checked) .name {
    opacity: 0.6;
  }

  .hide:has(input:checked) .mark {
    color: var(--muted);
  }

  .check:has(input:disabled) {
    opacity: 0.45;
    cursor: default;
  }

  small {
    margin-left: 4px;
    color: var(--muted);
    font-size: 13px;
  }

  @media (width < 760px) {
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .grid.wide {
      grid-template-columns: 1fr;
    }
  }
</style>
