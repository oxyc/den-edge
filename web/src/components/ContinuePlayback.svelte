<script lang="ts">
  import { i18n } from '../lib/i18n.svelte';
  import ButtonIcon from './ButtonIcon.svelte';
  import DetailIcon from './DetailIcon.svelte';

  let {
    href,
    label,
    episode,
    fraction,
    clock,
    device,
    playing = false,
    seekable = true,
    busy = false,
    onactivate,
    ontransport,
  }: {
    href: string;
    label: string;
    episode?: { season: number; episode: number };
    fraction?: number;
    clock?: string;
    device?: string;
    playing?: boolean;
    /** False for a retained ten-minute Resume lease: only Resume is safe until fresh activity returns. */
    seekable?: boolean;
    busy?: boolean;
    onactivate: (event: MouseEvent) => void;
    ontransport?: (action: 'play' | 'pause' | 'skip', offsetSeconds?: number) => void;
  } = $props();
</script>

<div
  class={`continue-widget${ontransport ? ' remote-player' : ''}`}
  data-spatial-section={ontransport || undefined}
  aria-label={ontransport ? `Controls for ${device ?? 'your TV'}` : undefined}
  aria-busy={ontransport ? busy : undefined}
>
  <a
    class={`continue${ontransport ? ' remote-title' : ''}`}
    {href}
    data-spatial-section={!ontransport || undefined}
    onclick={onactivate}
  >
    <span class="lead-icon" class:decorated={!!ontransport} aria-hidden="true">
      <DetailIcon name="play" filled />
    </span>
    <span class="continue-copy">
      <strong>{i18n.phrase(label)}</strong>
      {#if episode}<small>S{episode.season} · E{episode.episode}</small>{/if}
      {#if fraction !== undefined}
        <span class="resume-track"
          ><span style:width={`${fraction * 100}%`}></span>{#if clock}<span
              class={`live-clock${ontransport ? ' remote-clock' : ''}`}>{clock}</span
            >{/if}</span
        >
      {/if}
    </span>
  </a>

  {#if ontransport}
    <div class="remote-transport">
      {#if seekable}
        <button
          class="seek"
          type="button"
          disabled={busy}
          aria-label="Skip back 10 seconds"
          title="Back 10 seconds"
          onclick={() => ontransport('skip', -10)}
        >
          <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
            <path d="M17 13H9v-8M10 13a17 17 0 1 1-2 17" />
            <text x="24" y="29">10</text>
          </svg></button
        >
      {/if}
      <button
        class="play-pause"
        type="button"
        disabled={busy}
        aria-label={playing ? 'Pause on TV' : 'Resume on TV'}
        title={playing ? 'Pause' : 'Resume'}
        onclick={() => ontransport(playing ? 'pause' : 'play')}
      >
        <ButtonIcon name={playing ? 'pause' : 'play'} filled={!playing} />
      </button>
      {#if seekable}
        <button
          class="seek"
          type="button"
          disabled={busy}
          aria-label="Skip forward 10 seconds"
          title="Forward 10 seconds"
          onclick={() => ontransport('skip', 10)}
        >
          <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
            <path d="M31 13h8v-8M38 13a17 17 0 1 0 2 17" />
            <text x="24" y="29">10</text>
          </svg></button
        >
      {/if}
    </div>
  {/if}
</div>

<style>
  .continue-widget {
    display: inline-flex;
    max-width: 100%;
    align-items: center;
    gap: 8px;
  }

  .remote-player {
    width: min(100%, 460px);
  }

  .continue {
    display: inline-flex;
    min-width: 0;
    min-height: 52px;
    flex: 1 1 auto;
    align-items: center;
    gap: 16px;
    padding: 4px 0;
    border: 0;
    background: none;
    color: var(--fg);
    font: inherit;
    text-align: left;
    text-decoration: none;
    cursor: pointer;
  }

  .lead-icon {
    display: grid;
    width: 22px;
    height: 22px;
    flex: 0 0 auto;
    place-items: center;
    border-radius: 50%;
  }

  .lead-icon.decorated {
    background: #fff2;
    box-shadow: 0 0 0 6px #fff2;
  }

  .continue-copy {
    min-width: 0;
  }

  .continue strong,
  .continue small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .continue small {
    margin-top: 4px;
    color: var(--muted);
  }

  .resume-track {
    position: relative;
    display: block;
    width: 240px;
    max-width: 100%;
    height: 4px;
    margin-top: 10px;
    border-radius: 4px;
    background: #fff4;
  }

  .resume-track > span:first-child {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--fg);
  }

  .live-clock {
    position: absolute;
    top: 50%;
    left: calc(100% + 10px);
    color: var(--muted);
    font-size: 13px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    white-space: nowrap;
    transform: translateY(-50%);
  }

  .continue:focus-visible {
    outline: var(--ring-width) solid var(--focus-ring);
    outline-offset: 6px;
    border-radius: 6px;
  }

  .remote-transport {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 1px;
  }

  .remote-transport button {
    display: grid;
    width: 30px;
    height: 30px;
    flex: 0 0 auto;
    padding: 0;
    place-items: center;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--fg);
    font: inherit;
    cursor: pointer;
    transition:
      background 120ms ease,
      color 120ms ease,
      transform 120ms ease;
  }

  .remote-transport .seek svg {
    width: 24px;
    height: 24px;
    overflow: visible;
    fill: none;
    stroke: currentcolor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 3;
  }

  .remote-transport .seek text {
    fill: currentcolor;
    stroke: none;
    font-size: 14px;
    font-weight: 750;
    text-anchor: middle;
  }

  .remote-transport .play-pause {
    width: 34px;
    height: 34px;
    background: var(--fg);
    color: var(--bg);
    box-shadow: 0 3px 12px #0007;

    --button-icon-size: 16px;
  }

  .remote-transport button:hover {
    background: #fff2;
    transform: scale(1.05);
  }

  .remote-transport .play-pause:hover {
    background: #fff;
  }

  .remote-transport button:focus-visible {
    outline: var(--ring-width) solid var(--focus-ring);
    outline-offset: 2px;
  }

  .remote-transport button:disabled {
    cursor: wait;
    opacity: 0.55;
    transform: none;
  }
</style>
