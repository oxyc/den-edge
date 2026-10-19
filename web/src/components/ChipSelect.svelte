<script lang="ts">
  import ButtonIcon from './ButtonIcon.svelte';

  let {
    label,
    text,
    value,
    options,
    round = false,
    class: className = '',
    onchange,
  }: {
    /** The select's name, read out in place of the chip's text. */
    label: string;
    /** What the chip shows: the chosen option, as briefly as it can be said. */
    text: string;
    value: string;
    options: { value: string; label: string }[];
    /** A bordered pill, as chips are where there are many of them; otherwise a tray's selected chip. */
    round?: boolean;
    class?: string;
    onchange: (value: string) => void;
  } = $props();
</script>

<!-- A native select, so a phone opens its own picker and a screen reader reads a pop-up button. It lies unseen over the
     chip that shows the choice, as the opinion picker does (`TitleActions.svelte`). -->
<div class="pick {className}" class:round>
  <span aria-hidden="true">{text}</span>
  <ButtonIcon name="chevron" />
  <select aria-label={label} {value} onchange={(event) => onchange(event.currentTarget.value)}>
    {#each options as option (option.value)}
      <option value={option.value}>{option.label}</option>
    {/each}
  </select>
</div>

<style>
  .pick {
    --button-icon-size: 18px;

    position: relative;
    display: flex;
    flex: 1 0 auto;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 44px;
    padding: 8px 14px 8px 20px;
    border-radius: 10px;
    background: rgb(255 255 255 / 0.16);
    box-shadow: 0 1px 6px #0003;
    color: var(--fg);
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;

    /* The select can be laid out wider than the chip for a moment (WebKit), which would widen the page where the chip
       ends at its edge. `clip` rather than `hidden`: no scroll container to move. */
    overflow: clip;

    /* No text-selection caret or loupe on iOS over the label and glyph under the select that takes the tap. */
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }

  .round {
    border: 1px solid var(--line);
    border-radius: 999px;
  }

  .pick:has(select:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  /* The control itself fills the chip — never hidden, which would stop a phone opening it. */
  select {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    opacity: 0;
    appearance: none;
    font: inherit;
    cursor: pointer;
  }

  /* Where the browser draws the open menu itself, on its own ground. */
  option {
    color: initial;
  }

  @media (width <= 759px) {
    .pick {
      padding-inline: 16px 12px;
    }
  }
</style>
