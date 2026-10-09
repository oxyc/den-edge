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

  /* Alternative C is a clear, edge-heavy optical lens rather than B's frosted pane. The center preserves
     the scene behind it while the transparent border, caustics, and moving glint carry the material. */
  :global(.material-liquid) .den-button:not(.tertiary, .menu) {
    --button-bg: rgb(12 18 30 / 0.06);
    --button-border: transparent;
    --button-fg: #fff;
    --liquid-tint: rgb(107 166 255 / 0.08);
    --liquid-edge-a: rgb(205 240 255 / 0.76);
    --liquid-edge-b: rgb(255 181 235 / 0.42);
    --liquid-glow: rgb(84 152 255 / 0.22);

    position: relative;
    z-index: 0;
    overflow: hidden;
    border: 2px solid transparent;
    background:
      radial-gradient(ellipse 74% 82% at 50% 54%, rgb(3 8 18 / 0.22), transparent 76%) padding-box,
      linear-gradient(
          104deg,
          rgb(255 255 255 / 0.055),
          var(--liquid-tint) 52%,
          rgb(8 13 24 / 0.025)
        )
        padding-box,
      conic-gradient(
          from 218deg at 50% 50%,
          rgb(255 255 255 / 0.12) 0deg,
          var(--liquid-edge-a) 44deg,
          rgb(255 255 255 / 0.14) 94deg,
          var(--liquid-edge-b) 151deg,
          rgb(255 255 255 / 0.1) 211deg,
          rgb(152 208 255 / 0.72) 280deg,
          rgb(255 255 255 / 0.12) 360deg
        )
        border-box;
    color: var(--button-fg);
    box-shadow:
      inset 0 1px 1px rgb(255 255 255 / 0.3),
      inset 0 -2px 3px rgb(7 13 26 / 0.42),
      inset 2px 0 2px rgb(182 226 255 / 0.14),
      0 2px 2px rgb(0 0 0 / 0.42),
      0 11px 22px rgb(0 0 0 / 0.42),
      0 21px 46px rgb(0 0 0 / 0.28),
      0 0 24px var(--liquid-glow);
    text-shadow:
      0 1px 2px rgb(0 0 0 / 0.96),
      0 0 7px rgb(0 0 0 / 0.72);
    -webkit-backdrop-filter: blur(2px) saturate(190%) contrast(112%) brightness(108%);
    backdrop-filter: blur(2px) saturate(190%) contrast(112%) brightness(108%);
    isolation: isolate;
    transition:
      box-shadow 180ms ease,
      filter 180ms ease,
      transform 180ms cubic-bezier(0.2, 0.9, 0.2, 1);
  }

  :global(.material-liquid) .den-button:not(.tertiary, .menu)::before {
    position: absolute;
    z-index: -1;
    inset: -2px;
    border-radius: inherit;
    background:
      radial-gradient(
        58% 62% at 5% -12%,
        transparent 51%,
        rgb(255 255 255 / 0.72) 57%,
        transparent 66%
      ),
      radial-gradient(
        54% 82% at 105% 114%,
        transparent 56%,
        var(--liquid-edge-b) 63%,
        transparent 72%
      ),
      radial-gradient(
        28% 82% at -4% 62%,
        transparent 56%,
        rgb(126 205 255 / 0.42) 66%,
        transparent 75%
      );
    mix-blend-mode: screen;
    opacity: 0.72;
    content: '';
    pointer-events: none;
    transition:
      opacity 180ms ease,
      transform 420ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  :global(.material-liquid) .den-button:not(.tertiary, .menu)::after {
    position: absolute;
    z-index: -1;
    inset: 2px;
    border-radius: inherit;
    background: linear-gradient(
      112deg,
      transparent 14%,
      rgb(255 255 255 / 0.04) 25%,
      rgb(255 255 255 / 0.34) 32%,
      rgb(181 229 255 / 0.12) 37%,
      transparent 45% 74%,
      rgb(255 214 244 / 0.24) 82%,
      transparent 91%
    );
    background-position: 100% 0;
    background-size: 240% 100%;
    mix-blend-mode: screen;
    opacity: 0.68;
    content: '';
    pointer-events: none;
    transition:
      background-position 620ms cubic-bezier(0.16, 1, 0.3, 1),
      opacity 180ms ease,
      transform 180ms ease;
  }

  :global(.material-liquid) .den-button:not(.tertiary, .menu) > :global(*) {
    position: relative;
    z-index: 1;
    filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.9));
  }

  :global(.material-liquid) .den-button.primary {
    --button-fg: #fff;
    --liquid-tint: rgb(228 245 255 / 0.2);
    --liquid-edge-a: rgb(255 255 255 / 0.9);
    --liquid-edge-b: rgb(183 224 255 / 0.72);
    --liquid-glow: rgb(203 234 255 / 0.22);

    text-shadow:
      0 1px 2px rgb(0 0 0 / 0.92),
      0 0 7px rgb(0 0 0 / 0.66);
  }

  :global(.material-liquid) .den-button.device {
    --button-fg: #fff;
    --liquid-tint: rgb(37 103 255 / 0.24);
    --liquid-edge-a: rgb(202 232 255 / 0.84);
    --liquid-edge-b: rgb(91 134 255 / 0.72);
    --liquid-glow: rgb(57 118 255 / 0.42);
  }

  :global(.material-liquid) .den-button.destructive {
    --button-fg: #ffd8dc;
    --liquid-tint: rgb(206 43 72 / 0.2);
    --liquid-edge-a: rgb(255 229 233 / 0.88);
    --liquid-edge-b: rgb(255 94 125 / 0.72);
    --liquid-glow: rgb(226 48 82 / 0.3);
  }

  :global(.material-liquid) .pressed:not(.tertiary, .menu) {
    --button-fg: #fff;
    --liquid-tint: rgb(214 240 255 / 0.23);
    --liquid-edge-a: rgb(255 255 255 / 0.9);
    --liquid-edge-b: rgb(155 214 255 / 0.76);
    --liquid-glow: rgb(178 225 255 / 0.32);
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

  .den-button:hover:not(:disabled, [aria-disabled='true']) {
    border-color: color-mix(in srgb, currentcolor 38%, var(--button-border));
    background-color: color-mix(in srgb, var(--button-bg) 84%, white 16%);
  }

  .den-button:active:not(:disabled, [aria-disabled='true']) {
    transform: scale(0.975);
  }

  :global(.material-liquid) .den-button:not(.tertiary, .menu):hover::before {
    opacity: 1;
    transform: translate3d(5px, -2px, 0) scaleX(1.06);
  }

  :global(.material-liquid) .den-button:not(.tertiary, .menu):hover::after {
    background-position: 0 0;
    opacity: 1;
  }

  :global(.material-liquid) .den-button:not(.tertiary, .menu):hover {
    box-shadow:
      inset 0 1px 1px rgb(255 255 255 / 0.56),
      inset 0 -2px 3px rgb(7 13 26 / 0.38),
      inset 2px 0 2px rgb(182 226 255 / 0.22),
      0 2px 2px rgb(0 0 0 / 0.42),
      0 14px 28px rgb(0 0 0 / 0.46),
      0 26px 54px rgb(0 0 0 / 0.3),
      0 0 30px var(--liquid-glow);
    filter: brightness(1.08);
    transform: translateY(-1px);
  }

  :global(.material-liquid) .den-button:not(.tertiary, .menu):active {
    box-shadow:
      inset 0 2px 5px rgb(0 0 0 / 0.28),
      inset 0 -1px 1px rgb(255 255 255 / 0.34),
      0 4px 9px rgb(0 0 0 / 0.38),
      0 0 18px var(--liquid-glow);
    filter: brightness(1.14) saturate(1.12);
    transform: translateY(2px) scale(0.965, 0.91);
  }

  :global(.material-liquid) .den-button:not(.tertiary, .menu):active::before {
    opacity: 0.72;
    transform: translate3d(-4px, 3px, 0) scaleX(1.12) scaleY(0.9);
  }

  :global(.material-liquid) .den-button:not(.tertiary, .menu):active::after {
    background-position: 35% 0;
    opacity: 1;
    transform: scaleX(1.12);
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

    :global(.material-liquid) .den-button:not(.tertiary, .menu),
    :global(.material-liquid) .den-button:not(.tertiary, .menu)::before,
    :global(.material-liquid) .den-button:not(.tertiary, .menu)::after {
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

    :global(.material-liquid) .den-button:not(.tertiary, .menu) {
      border-color: rgb(255 255 255 / 0.34);
      background: #30333f;
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }

    :global(.material-liquid) .den-button.primary,
    :global(.material-liquid) .pressed:not(.tertiary, .menu) {
      --button-fg: #101116;

      background: #f2f2f6;
      text-shadow: none;
    }

    :global(.material-liquid) .den-button.device {
      background: #376fe1;
    }

    :global(.material-liquid) .den-button.destructive {
      background: #702735;
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

    :global(.material-liquid) .den-button:not(.tertiary, .menu) {
      border-color: rgb(255 255 255 / 0.34);
      background: #30333f;
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }

    :global(.material-liquid) .den-button.primary,
    :global(.material-liquid) .pressed:not(.tertiary, .menu) {
      --button-fg: #101116;

      background: #f2f2f6;
      text-shadow: none;
    }

    :global(.material-liquid) .den-button.device {
      background: #376fe1;
    }

    :global(.material-liquid) .den-button.destructive {
      background: #702735;
    }
  }
</style>
