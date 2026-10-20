<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import type { ButtonIconName } from './ButtonIcon.svelte';

  export type ButtonVariant =
    | 'primary'
    | 'secondary'
    | 'tertiary'
    | 'device'
    | 'destructive'
    | 'stateful'
    | 'menu'
    | 'player';
  export type ButtonSize = 'large' | 'regular' | 'compact' | 'icon';

  export interface ButtonProps extends Omit<
    HTMLButtonAttributes,
    'children' | 'class' | 'disabled' | 'onclick' | 'type'
  > {
    children?: Snippet;
    label?: string;
    icon?: ButtonIconName;
    iconFilled?: boolean;
    variant?: ButtonVariant;
    size?: ButtonSize;
    pressed?: boolean;
    busy?: boolean;
    /** The save `busy` stands for is one the person is waiting on: the button pulses once the wait is long enough to notice. */
    saving?: boolean;
    disabled?: boolean;
    ariaLabel?: string;
    class?: string;
    type?: 'button' | 'submit' | 'reset';
    /**
     * Where this control leads, for one that goes to a page rather than acts: drawn as a link with the same look, so it
     * opens in a new tab like any other. A plain click is the Router's (`Router.svelte`), after `onclick`.
     */
    href?: string;
    element?: HTMLButtonElement;
    onclick?: (event: MouseEvent) => void;
  }
</script>

<script lang="ts">
  import ButtonIcon from './ButtonIcon.svelte';

  let {
    children,
    label,
    icon,
    iconFilled = false,
    variant = 'secondary',
    size = 'regular',
    pressed,
    busy = false,
    saving = false,
    disabled = false,
    ariaLabel,
    class: className = '',
    type = 'button',
    href,
    element = $bindable(),
    onclick,
    ...attributes
  }: ButtonProps = $props();

  function activate(event: MouseEvent) {
    if (
      busy ||
      disabled ||
      attributes['aria-disabled'] === true ||
      attributes['aria-disabled'] === 'true'
    ) {
      event.preventDefault();
      return;
    }
    onclick?.(event);
  }
</script>

{#snippet contents()}
  {#if icon}<ButtonIcon name={icon} filled={iconFilled} />{/if}
  {#if label}<span class="den-button-label">{label}</span>{/if}
  {#if children}{@render children()}{/if}
{/snippet}

{#if href !== undefined}
  <a
    {href}
    role={attributes.role}
    class="den-button den-button-{variant} den-button-{size} {className}"
    aria-label={ariaLabel ?? attributes['aria-label'] ?? label}
    aria-describedby={attributes['aria-describedby']}
    {onclick}>{@render contents()}</a
  >
{:else}
  <button
    bind:this={element}
    {...attributes}
    {type}
    class="den-button den-button-{variant} den-button-{size} {className}"
    aria-label={ariaLabel ?? attributes['aria-label'] ?? label}
    aria-pressed={pressed ?? attributes['aria-pressed']}
    aria-busy={busy || attributes['aria-busy'] || undefined}
    data-saving={saving || undefined}
    aria-disabled={busy || attributes['aria-disabled'] || undefined}
    {disabled}
    onclick={activate}>{@render contents()}</button
  >
{/if}
