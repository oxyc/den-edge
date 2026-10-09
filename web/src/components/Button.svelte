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
    disabled?: boolean;
    ariaLabel?: string;
    class?: string;
    type?: 'button' | 'submit' | 'reset';
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
    disabled = false,
    ariaLabel,
    class: className = '',
    type = 'button',
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

<button
  bind:this={element}
  {...attributes}
  {type}
  class="den-button den-button-{variant} den-button-{size} {className}"
  aria-label={ariaLabel ?? attributes['aria-label'] ?? label}
  aria-pressed={pressed ?? attributes['aria-pressed']}
  aria-busy={busy || attributes['aria-busy'] || undefined}
  aria-disabled={busy || attributes['aria-disabled'] || undefined}
  {disabled}
  onclick={activate}>{@render contents()}</button
>
