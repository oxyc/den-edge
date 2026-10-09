<script lang="ts" module>
  import type { DenIconName } from './DenIcon.svelte';

  export type DenButtonVariant =
    'primary' | 'secondary' | 'tertiary' | 'device' | 'destructive' | 'menu' | 'player';
  export type DenButtonSize = 'large' | 'regular' | 'compact' | 'icon';

  export interface DenButtonProps {
    label?: string;
    ariaLabel?: string;
    icon?: DenIconName;
    variant?: DenButtonVariant;
    size?: DenButtonSize;
    pressed?: boolean;
    busy?: boolean;
    disabled?: boolean;
    trailing?: DenIconName;
    role?: 'menuitem' | 'menuitemcheckbox' | 'menuitemradio';
    onclick?: (event: MouseEvent) => void;
  }
</script>

<script lang="ts">
  import DenIcon from './DenIcon.svelte';

  let {
    label,
    ariaLabel,
    icon,
    variant = 'secondary',
    size = 'regular',
    pressed,
    busy = false,
    disabled = false,
    trailing,
    role,
    onclick,
  }: DenButtonProps = $props();
</script>

<button
  type="button"
  class="den-button {variant} {size}"
  class:pressed
  {role}
  aria-label={ariaLabel ?? label}
  aria-pressed={role ? undefined : pressed}
  aria-checked={role === 'menuitemcheckbox' || role === 'menuitemradio' ? pressed : undefined}
  aria-busy={busy || undefined}
  aria-disabled={busy || undefined}
  {disabled}
  onclick={(event) => !busy && !disabled && onclick?.(event)}
>
  {#if busy}<span class="spinner" aria-hidden="true"></span>{:else if icon}<DenIcon
      name={icon}
    />{/if}
  {#if label}<span>{label}</span>{/if}
  {#if trailing}<span class="trailing"><DenIcon name={trailing} /></span>{/if}
</button>

<style>
  .den-button {
    --button-bg: transparent;
    --button-border: var(--line);
    --button-fg: var(--fg);

    display: inline-flex;
    gap: 8px;
    align-items: center;
    justify-content: center;
    min-width: 0;
    min-height: 44px;
    padding: 0 16px;
    border: 1px solid var(--button-border);
    border-radius: 12px;
    background: var(--button-bg);
    color: var(--button-fg);
    font: inherit;
    font-weight: 600;
    line-height: 1;
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    transition:
      background-color 120ms ease,
      border-color 120ms ease,
      color 120ms ease,
      transform 80ms ease;
  }

  .large {
    min-height: 48px;
    padding-inline: 22px;
    font-size: 16px;
  }

  .compact {
    min-height: 36px;
    padding-inline: 12px;
    border-radius: 9px;
    font-size: 14px;
  }

  .icon {
    width: 44px;
    padding: 0;
    border-radius: 50%;
  }

  .primary {
    --button-bg: var(--fg);
    --button-border: var(--fg);
    --button-fg: var(--bg);
  }

  .secondary {
    --button-bg: rgb(255 255 255 / 0.08);
    --button-border: rgb(255 255 255 / 0.14);
  }

  .tertiary {
    --button-border: transparent;

    color: var(--muted);
  }

  .device {
    --button-bg: color-mix(in srgb, var(--accent) 16%, transparent);
    --button-border: color-mix(in srgb, var(--accent) 62%, var(--line));

    color: #aac2ff;
  }

  .destructive {
    --button-bg: color-mix(in srgb, var(--danger) 12%, transparent);
    --button-border: color-mix(in srgb, var(--danger) 48%, var(--line));

    color: #ff9a9a;
  }

  .menu {
    width: 100%;
    justify-content: flex-start;
    border-color: transparent;
    background: transparent;
    font-weight: 500;
  }

  .player {
    --button-bg: var(--glass-bg);
    --button-border: var(--glass-edge);

    color: #fff;
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.08),
      0 8px 24px rgb(0 0 0 / 0.3);
    -webkit-backdrop-filter: var(--glass-blur);
    backdrop-filter: var(--glass-blur);
  }

  .pressed {
    --button-bg: var(--fg);
    --button-border: var(--fg);
    --button-fg: var(--bg);
  }

  .tertiary.pressed,
  .menu.pressed {
    --button-bg: rgb(255 255 255 / 0.12);
    --button-border: transparent;
    --button-fg: var(--fg);
  }

  .den-button:focus-visible {
    outline: 3px solid color-mix(in srgb, var(--accent) 82%, white);
    outline-offset: 3px;
  }

  .den-button:disabled,
  .den-button[aria-disabled='true'] {
    opacity: 0.45;
    cursor: default;
  }

  .den-button[aria-busy='true'] {
    cursor: progress;
  }

  /* Alternative B lives behind the demo's material switch. Blur is bounded to actual control surfaces; menu rows
     and quiet utilities remain flat so a list never creates a stack of compositor-backed panes. */
  :global(.material-glass) .den-button:not(.tertiary, .menu) {
    --button-bg: rgb(48 51 63 / 0.55);
    --button-border: rgb(255 255 255 / 0.22);
    --button-fg: #f7f7fb;

    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.16),
      inset 0 -1px 0 rgb(0 0 0 / 0.12),
      0 10px 26px rgb(0 0 0 / 0.25);
    -webkit-backdrop-filter: blur(18px) saturate(155%);
    backdrop-filter: blur(18px) saturate(155%);
  }

  :global(.material-glass) .den-button.primary {
    --button-bg: rgb(248 248 252 / 0.9);
    --button-border: rgb(255 255 255 / 0.84);
    --button-fg: #111217;
  }

  :global(.material-glass) .den-button.device {
    --button-bg: rgb(47 104 255 / 0.62);
    --button-border: rgb(141 177 255 / 0.76);
    --button-fg: #fff;

    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.24),
      inset 0 -1px 0 rgb(0 25 88 / 0.25),
      0 10px 28px rgb(30 75 190 / 0.3);
  }

  :global(.material-glass) .den-button.destructive {
    --button-bg: rgb(120 32 42 / 0.46);
    --button-border: rgb(255 125 136 / 0.54);
    --button-fg: #ffd8dc;
  }

  :global(.material-glass) .pressed:not(.tertiary, .menu) {
    --button-bg: rgb(248 248 252 / 0.94);
    --button-border: #fff;
    --button-fg: #101116;

    box-shadow:
      inset 0 1px 0 #fff,
      inset 0 -1px 0 rgb(0 0 0 / 0.16),
      0 8px 22px rgb(0 0 0 / 0.24);
  }

  :global(.material-glass) .tertiary,
  :global(.material-glass) .menu {
    --button-border: transparent;
    --button-fg: #e8e8ee;
  }

  :global(.material-glass) .menu.pressed,
  :global(.material-glass) .tertiary.pressed {
    --button-bg: rgb(255 255 255 / 0.13);
  }

  /* Alternative C turns the same hierarchy into a lens-like material. The curved highlights and context tint
     are paint-only; no pointer listener or permanent compositor hint is needed. */
  :global(.material-liquid) .den-button:not(.tertiary, .menu) {
    --button-bg: rgb(48 51 63 / 0.55);
    --button-border: rgb(255 255 255 / 0.22);
    --button-fg: #f7f7fb;

    position: relative;
    overflow: hidden;
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.24),
      inset 0 -1px 0 rgb(0 0 0 / 0.2),
      inset 1px 0 0 rgb(255 255 255 / 0.08),
      0 10px 26px rgb(0 0 0 / 0.25);
    text-shadow: 0 1px 1px rgb(0 0 0 / 0.28);
    -webkit-backdrop-filter: blur(18px) saturate(155%);
    backdrop-filter: blur(18px) saturate(155%);
    isolation: isolate;
  }

  :global(.material-liquid) .den-button:not(.tertiary, .menu)::before {
    position: absolute;
    inset: 1px;
    border-radius: inherit;
    background:
      radial-gradient(90% 75% at 18% -26%, rgb(255 255 255 / 0.42), transparent 58%),
      radial-gradient(
        75% 110% at 104% 118%,
        color-mix(in srgb, currentcolor 20%, transparent),
        transparent 64%
      ),
      linear-gradient(112deg, rgb(255 255 255 / 0.1), transparent 30% 72%, rgb(255 255 255 / 0.08));
    opacity: 0.72;
    content: '';
    pointer-events: none;
    transition:
      opacity 120ms ease,
      transform 100ms ease;
  }

  :global(.material-liquid) .den-button.primary {
    --button-bg: rgb(248 248 252 / 0.9);
    --button-border: rgb(255 255 255 / 0.84);
    --button-fg: #111217;

    text-shadow: 0 1px 0 rgb(255 255 255 / 0.36);
  }

  :global(.material-liquid) .den-button.device {
    --button-bg: rgb(47 104 255 / 0.62);
    --button-border: rgb(141 177 255 / 0.76);
    --button-fg: #fff;

    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.34),
      inset 0 -1px 0 rgb(0 25 88 / 0.25),
      0 10px 28px rgb(30 75 190 / 0.38),
      0 0 20px rgb(70 123 255 / 0.14);
  }

  :global(.material-liquid) .den-button.destructive {
    --button-bg: rgb(120 32 42 / 0.46);
    --button-border: rgb(255 125 136 / 0.54);
    --button-fg: #ffd8dc;
  }

  :global(.material-liquid) .pressed:not(.tertiary, .menu) {
    --button-bg: rgb(248 248 252 / 0.94);
    --button-border: #fff;
    --button-fg: #101116;

    box-shadow:
      inset 0 1px 0 #fff,
      inset 0 -1px 0 rgb(0 0 0 / 0.16),
      0 8px 22px rgb(0 0 0 / 0.24),
      0 0 18px rgb(255 255 255 / 0.1);
    text-shadow: 0 1px 0 rgb(255 255 255 / 0.38);
  }

  :global(.material-liquid) .tertiary,
  :global(.material-liquid) .menu {
    --button-border: transparent;
    --button-fg: #e8e8ee;
  }

  :global(.material-liquid) .menu.pressed,
  :global(.material-liquid) .tertiary.pressed {
    --button-bg: rgb(255 255 255 / 0.13);
  }

  :global(.material-liquid) .den-button:not(.tertiary, .menu):hover::before {
    opacity: 0.96;
    transform: translateY(-1px) scaleX(1.015);
  }

  :global(.material-liquid) .den-button:not(.tertiary, .menu):active::before {
    opacity: 0.56;
    transform: translateY(2px) scaleX(1.04);
  }

  .den-button:hover:not(:disabled, [aria-disabled='true']) {
    border-color: color-mix(in srgb, currentcolor 38%, var(--button-border));
    background-color: color-mix(in srgb, var(--button-bg) 84%, white 16%);
  }

  .den-button:active:not(:disabled, [aria-disabled='true']) {
    transform: scale(0.975);
  }

  .trailing {
    margin-left: auto;
    opacity: 0.58;
  }

  .trailing :global(svg) {
    width: 15px;
    height: 15px;
  }

  .spinner {
    width: 17px;
    height: 17px;
    border: 2px solid currentcolor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 700ms linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .den-button {
      transition: none;
    }

    :global(.material-liquid) .den-button:not(.tertiary, .menu)::before {
      transition: none;
    }

    .spinner {
      animation-duration: 1400ms;
    }
  }

  @media (prefers-reduced-transparency: reduce) {
    .player {
      background: rgb(28 28 34);
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }

    :global(.material-glass) .den-button:not(.tertiary, .menu),
    :global(.material-liquid) .den-button:not(.tertiary, .menu) {
      --button-bg: #30333f;

      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }

    :global(.material-glass) .den-button.primary,
    :global(.material-glass) .pressed:not(.tertiary, .menu),
    :global(.material-liquid) .den-button.primary,
    :global(.material-liquid) .pressed:not(.tertiary, .menu) {
      --button-bg: #f2f2f6;
    }

    :global(.material-glass) .den-button.device,
    :global(.material-liquid) .den-button.device {
      --button-bg: #376fe1;
    }
  }

  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    :global(.material-glass) .den-button:not(.tertiary, .menu),
    :global(.material-liquid) .den-button:not(.tertiary, .menu) {
      --button-bg: #30333f;

      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }

    :global(.material-glass) .den-button.primary,
    :global(.material-glass) .pressed:not(.tertiary, .menu),
    :global(.material-liquid) .den-button.primary,
    :global(.material-liquid) .pressed:not(.tertiary, .menu) {
      --button-bg: #f2f2f6;
    }

    :global(.material-glass) .den-button.device,
    :global(.material-liquid) .den-button.device {
      --button-bg: #376fe1;
    }
  }
</style>
