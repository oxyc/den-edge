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

  export interface ButtonProps {
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
    onkeydown?: (event: KeyboardEvent) => void;
    onpointerdown?: (event: PointerEvent) => void;
    id?: string;
    title?: string;
    role?: HTMLButtonAttributes['role'];
    tabindex?: number;
    'aria-label'?: string;
    'aria-describedby'?: string;
    'aria-busy'?: boolean | 'true' | 'false';
    'aria-disabled'?: boolean | 'true' | 'false';
    'aria-pressed'?: boolean | 'true' | 'false' | 'mixed';
    'aria-checked'?: boolean | 'true' | 'false' | 'mixed';
    'aria-controls'?: string;
    'aria-expanded'?: boolean | 'true' | 'false';
    'aria-haspopup'?: HTMLButtonAttributes['aria-haspopup'];
    'data-pair-answer'?: string | boolean;
    'data-pair-start'?: string | boolean;
  }
</script>

<script lang="ts">
  import { i18n } from '../lib/i18n.svelte';
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
    onkeydown,
    onpointerdown,
    id,
    title,
    role,
    tabindex,
    'aria-label': ariaLabelAttribute,
    'aria-describedby': ariaDescribedby,
    'aria-busy': ariaBusy,
    'aria-disabled': ariaDisabled,
    'aria-pressed': ariaPressed,
    'aria-checked': ariaChecked,
    'aria-controls': ariaControls,
    'aria-expanded': ariaExpanded,
    'aria-haspopup': ariaHaspopup,
    'data-pair-answer': pairAnswer,
    'data-pair-start': pairStart,
  }: ButtonProps = $props();

  function activate(event: MouseEvent) {
    if (unavailable()) {
      event.preventDefault();
      return;
    }
    onclick?.(event);
  }

  /**
   * A Button rendered as a link cannot use the native `disabled` attribute. Keep one source of truth for its
   * interaction and accessibility state: previously `disabled` stopped activation but was missing from
   * `aria-disabled`, so assistive technology still announced an enabled link. Removing its destination also stops
   * a disabled link being opened through the context menu while `tabindex=0` preserves the deliberate focus-stable
   * behaviour used while a save is in flight.
   */
  function unavailable() {
    return busy || disabled || ariaDisabled === true || ariaDisabled === 'true';
  }

  const localizedLabel = $derived(label ? i18n.phrase(label) : undefined);
  const localizedAriaLabel = $derived(i18n.phrase(ariaLabel ?? ariaLabelAttribute ?? label ?? ''));
</script>

{#snippet contents()}
  {#if icon}<ButtonIcon name={icon} filled={iconFilled} />{/if}
  {#if localizedLabel}<span class="den-button-label">{localizedLabel}</span>{/if}
  {#if children}{@render children()}{/if}
{/snippet}

{#if href !== undefined}
  <a
    href={unavailable() ? undefined : href}
    role={role ?? 'link'}
    tabindex={tabindex ?? (unavailable() ? 0 : undefined)}
    {id}
    title={title ? i18n.phrase(title) : undefined}
    class="den-button den-button-{variant} den-button-{size} {className}"
    aria-label={localizedAriaLabel || undefined}
    aria-describedby={ariaDescribedby}
    aria-busy={busy || ariaBusy || undefined}
    aria-disabled={unavailable() || undefined}
    aria-checked={ariaChecked}
    aria-controls={ariaControls}
    aria-expanded={ariaExpanded}
    aria-haspopup={ariaHaspopup}
    data-pair-answer={pairAnswer}
    data-pair-start={pairStart}
    {onkeydown}
    {onpointerdown}
    onclick={activate}>{@render contents()}</a
  >
{:else}
  <button
    bind:this={element}
    {type}
    {id}
    title={title ? i18n.phrase(title) : undefined}
    {role}
    {tabindex}
    class="den-button den-button-{variant} den-button-{size} {className}"
    aria-label={localizedAriaLabel || undefined}
    aria-describedby={ariaDescribedby}
    aria-pressed={pressed ?? ariaPressed}
    aria-checked={ariaChecked}
    aria-controls={ariaControls}
    aria-expanded={ariaExpanded}
    aria-haspopup={ariaHaspopup}
    aria-busy={busy || ariaBusy || undefined}
    data-saving={saving || undefined}
    aria-disabled={busy || ariaDisabled || undefined}
    data-pair-answer={pairAnswer}
    data-pair-start={pairStart}
    {onkeydown}
    {onpointerdown}
    {disabled}
    onclick={activate}>{@render contents()}</button
  >
{/if}
