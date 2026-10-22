<script lang="ts">
  import type { ProfileChoice } from '../lib/profileModeCoordinator.svelte';

  let {
    choice,
    compact = false,
    neutral = false,
  }: { choice: ProfileChoice | null; compact?: boolean; neutral?: boolean } = $props();
  const letter = $derived(
    choice?.avatar === 'kid' ? 'K' : choice?.avatar === 'visitor' ? 'V' : 'O',
  );
  const avatarId = $props.id();
</script>

<span
  class:kid={choice?.role === 'kid'}
  class:visitor={choice?.role === 'visitor'}
  class:compact
  class:neutral
  class="avatar"
  aria-hidden="true"
>
  {#if neutral}
    <svg viewBox="0 0 24 24" focusable="false">
      <defs>
        <clipPath id={`${avatarId}-den-opening`}>
          <path d="M6 21V12a6 6 0 0 1 12 0V21Z" />
        </clipPath>
      </defs>
      <g class="doorway-clip" clip-path={`url(#${avatarId}-den-opening)`}>
        <g class="occupant">
          <circle cx="12" cy="10.7" r="2.25" />
          <path d="M8.2 27v-5c0-5 1.3-7.5 3.8-7.5s3.8 2.5 3.8 7.5v5Z" />
        </g>
      </g>
      <path class="den-arch" d="M5 21V12a7 7 0 0 1 14 0V21" />
    </svg>
  {:else}
    {letter}
  {/if}
</span>

<style>
  .avatar {
    display: inline-grid;
    flex: 0 0 auto;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: linear-gradient(145deg, #9f7aea, #6b46c1);
    color: white;
    font-weight: 750;
  }

  .avatar.compact {
    width: 28px;
    height: 28px;
    font-size: 13px;
  }

  .avatar.compact.neutral {
    width: 18px;
    height: 18px;
    overflow: hidden;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font-size: 12px;
    transition: color 120ms ease;
  }

  .neutral svg {
    width: 18px;
    height: 18px;
    overflow: hidden;
    fill: currentcolor;
    transform: translateY(-0.75px);
  }

  .neutral .occupant {
    transform: var(--den-occupant-transform, translate(5.5px, 0.4px) rotate(-20deg));
    transform-box: fill-box;
    transform-origin: center;
    transition: transform 190ms ease-out;
  }

  .neutral .den-arch {
    fill: none;
    stroke: currentcolor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.7;
  }

  .avatar.neutral.kid {
    color: #679f94;
    color: color-mix(in srgb, #54a897 72%, var(--muted));
  }

  .avatar.neutral.visitor {
    color: #88809e;
    color: color-mix(in srgb, #8b7da8 72%, var(--muted));
  }

  @media (prefers-reduced-motion: reduce) {
    .neutral .occupant {
      transform: translate(5.5px, 0.4px) rotate(-20deg);
      transition: none;
    }
  }

  .avatar.kid:not(.neutral) {
    background: linear-gradient(145deg, #34d399, #047857);
  }

  .avatar.visitor:not(.neutral) {
    background: linear-gradient(145deg, #64748b, #334155);
  }
</style>
