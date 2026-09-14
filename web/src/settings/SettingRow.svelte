<!-- One row of a settings plate, as the TV's Form rows read: a label on the left, a quiet value on the right. A row that
     opens a screen on the TV opens in place here instead (`children`), so nothing is a page of its own; a row with a
     control of its own (a switch, a select) takes it as `control`. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    id,
    label,
    detail,
    value,
    open = $bindable(false),
    control,
    children,
  }: {
    /** Stable, and the address a link to this row uses (`/settings#<id>`). */
    id: string;
    label: string;
    /** A second, quieter line under the label. */
    detail?: string;
    /** What's chosen, said the way the TV's row says it: "Original", "3", "Not set". */
    value?: string;
    open?: boolean;
    /** A control that sits in the value's place, for a setting that needs no more room than that. */
    control?: Snippet;
    /** What the row opens to. */
    children?: Snippet;
  } = $props();
</script>

<div class="item" {id}>
  {#if children}
    <button
      type="button"
      class="row"
      aria-expanded={open}
      aria-controls="{id}-panel"
      onclick={() => (open = !open)}
    >
      <span class="label"
        >{label}{#if detail}<small>{detail}</small>{/if}</span
      >
      {#if value}<span class="value">{value}</span>{/if}
      <svg class="chevron" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path d="m9 6 6 6-6 6" />
      </svg>
    </button>
    <!-- Escape from any control inside closes the row. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="panel"
      id="{id}-panel"
      role="region"
      aria-label={label}
      hidden={!open}
      onkeydown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        open = false;
        document.querySelector<HTMLElement>(`#${CSS.escape(id)} > .row`)?.focus();
      }}
    >
      {#if open}{@render children()}{/if}
    </div>
  {:else}
    <div class="row static">
      <span class="label" id="{id}-label"
        >{label}{#if detail}<small>{detail}</small>{/if}</span
      >
      {#if control}{@render control()}{:else if value}<span class="value">{value}</span>{/if}
    </div>
  {/if}
</div>

<style>
  .item {
    border-radius: var(--radius);
    background: var(--card);
    scroll-margin-top: calc(var(--bar-space) + 64px);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 54px;
    padding: 8px 16px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .row.static {
    cursor: default;
  }

  button.row:hover {
    background: rgb(255 255 255 / 0.03);
  }

  button.row:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .label {
    min-width: 0;
    margin-right: auto;
  }

  .label small {
    display: block;
    color: var(--muted);
    font-size: 13px;
  }

  .value {
    color: var(--muted);
    white-space: nowrap;
  }

  .chevron {
    flex-shrink: 0;
    fill: none;
    stroke: var(--muted);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 0.18s;
  }

  [aria-expanded='true'] .chevron {
    transform: rotate(90deg);
  }

  .panel {
    padding: 4px 16px 18px;
    border-top: 1px solid var(--line);
  }

  @media (width < 760px) {
    .row {
      min-height: 56px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .chevron {
      transition: none;
    }
  }
</style>
