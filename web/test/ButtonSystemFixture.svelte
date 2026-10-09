<script lang="ts">
  import DenButton from './button-system/DenButton.svelte';

  type Material = 'solid' | 'glass';
  let material = $state<Material>(
    new URLSearchParams(location.search).get('material') === 'glass' ? 'glass' : 'solid',
  );
  let watchlisted = $state(false);
  let seen = $state(true);
  let busy = $state(false);
  let notice = $state('Ready');

  function act(label: string) {
    notice = label;
  }

  function save() {
    busy = true;
    notice = 'Saving…';
    setTimeout(() => {
      busy = false;
      notice = 'Saved';
    }, 900);
  }

  function chooseMaterial(next: Material) {
    material = next;
    const url = new URL(location.href);
    if (next === 'glass') url.searchParams.set('material', 'glass');
    else url.searchParams.delete('material');
    history.replaceState(null, '', url);
  }
</script>

<svelte:head><title>Den button system demo</title></svelte:head>

<main class:material-glass={material === 'glass'}>
  <header class="intro">
    <div class="demo-toolbar">
      <p class="eyebrow">Design demo · no production integration</p>
      <div class="material-picker" role="group" aria-label="Button material alternative">
        <DenButton
          size="compact"
          label="A · Solid"
          pressed={material === 'solid'}
          onclick={() => chooseMaterial('solid')}
        />
        <DenButton
          size="compact"
          label="B · Glass"
          pressed={material === 'glass'}
          onclick={() => chooseMaterial('glass')}
        />
      </div>
    </div>
    <h1>One button language for Den</h1>
    <p class="lede">
      A small hierarchy for every action surface: detail pages, settings, menus, failures, and the
      player. It keeps Den’s existing type, colors, icons, and touch targets while removing one-off
      button CSS.
    </p>
  </header>

  <section class="detail-stage" aria-labelledby="detail-title">
    <div class="art" aria-hidden="true"></div>
    <div class="detail-copy">
      <p class="eyebrow">Representative detail group</p>
      <h2 id="detail-title">End of Summer</h2>
      <p class="metadata">2023 · Drama · Mystery</p>
      <p class="summary">
        Primary playback is unmistakable. Trailer stays secondary, a remote device action is visibly
        distinct, and saved states carry both fill and accessible pressed state.
      </p>
      <div class="hero-actions" aria-label="Title actions">
        <DenButton
          variant="primary"
          size="large"
          icon="play"
          label="Play"
          onclick={() => act('Play')}
        />
        <DenButton
          variant="secondary"
          size="large"
          icon="trailer"
          label="Trailer"
          onclick={() => act('Trailer')}
        />
        <DenButton
          variant="device"
          size="large"
          icon="tv"
          label="Play on TV"
          onclick={() => act('Play on TV')}
        />
        <DenButton
          icon="bookmark"
          label="Watchlist"
          pressed={watchlisted}
          onclick={() => (watchlisted = !watchlisted)}
        />
        <DenButton icon="eye" label="Seen" pressed={seen} onclick={() => (seen = !seen)} />
        <DenButton icon="share" label="Share" variant="tertiary" onclick={() => act('Share')} />
      </div>
      <p class="notice" role="status">{notice}</p>
    </div>
  </section>

  <section aria-labelledby="hierarchy-title">
    <div class="section-heading">
      <div>
        <p class="eyebrow">Core hierarchy</p>
        <h2 id="hierarchy-title">Roles, states, four sizes</h2>
      </div>
      <p>
        Role describes intent; size describes context. Neither component names nor pages define
        appearance.
      </p>
    </div>
    <div class="spec-grid">
      <article>
        <h3>Primary</h3>
        <p>One dominant task per region.</p>
        <DenButton variant="primary" icon="play" label="Continue" />
      </article>
      <article>
        <h3>Secondary</h3>
        <p>Peer actions and ordinary controls.</p>
        <DenButton icon="trailer" label="Trailer" />
      </article>
      <article>
        <h3>Tertiary</h3>
        <p>Low-emphasis utilities, not fake links.</p>
        <DenButton variant="tertiary" icon="share" label="Copy link" />
      </article>
      <article>
        <h3>Device</h3>
        <p>A clear context switch to another screen.</p>
        <DenButton variant="device" icon="tv" label="Play on TV" />
      </article>
      <article>
        <h3>Destructive</h3>
        <p>Reserved for irreversible or high-cost actions.</p>
        <DenButton variant="destructive" icon="trash" label="Remove guest" />
      </article>
      <article>
        <h3>Stateful</h3>
        <p>Stable label plus visible and spoken state.</p>
        <DenButton icon="bookmark" label="Watchlist" pressed />
      </article>
    </div>
  </section>

  <section aria-labelledby="states-title">
    <div class="section-heading">
      <div>
        <p class="eyebrow">Behavior contract</p>
        <h2 id="states-title">Every state has a meaning</h2>
      </div>
      <p>
        Tab through this row to inspect focus. Pressed, disabled, and loading are semantic
        attributes too.
      </p>
    </div>
    <div class="state-row">
      <DenButton variant="primary" label="Save changes" onclick={save} {busy} />
      <DenButton label="Selected" icon="eye" pressed />
      <DenButton label="Unavailable" icon="play" disabled />
      <DenButton variant="destructive" label="Delete download" icon="trash" />
      <DenButton variant="secondary" size="compact" label="Try again" icon="retry" />
    </div>
  </section>

  <section class="surface-grid" aria-label="Context examples">
    <article class="menu-card">
      <p class="eyebrow">Menus & settings</p>
      <h2>Full-width choices</h2>
      <div class="menu" role="menu" aria-label="Download actions">
        <DenButton variant="menu" icon="download" label="Download" role="menuitem" />
        <DenButton variant="menu" icon="eye" label="Mark as seen" role="menuitemcheckbox" pressed />
        <DenButton variant="menu" icon="share" label="Share" role="menuitem" />
        <DenButton variant="menu" icon="trash" label="Remove download" role="menuitem" />
      </div>
    </article>

    <article class="player-card">
      <div class="player-copy">
        <p class="eyebrow">Player controls</p>
        <h2>Silo · Episode 3</h2>
      </div>
      <div class="player-bar" aria-label="Player controls">
        <DenButton variant="player" size="icon" icon="back" ariaLabel="Back" />
        <DenButton variant="player" size="icon" icon="pause" ariaLabel="Pause" />
        <DenButton variant="player" size="icon" icon="volume" ariaLabel="Mute" />
        <span class="player-time">18:42 / 52:08</span>
        <DenButton variant="player" size="compact" icon="play" label="Skip intro" />
        <DenButton variant="player" size="icon" icon="fullscreen" ariaLabel="Full screen" />
      </div>
    </article>
  </section>

  <section aria-labelledby="compact-title">
    <div class="section-heading">
      <div>
        <p class="eyebrow">Compact & icon-only</p>
        <h2 id="compact-title">Small chrome, full targets</h2>
      </div>
      <p>
        Icon-only actions stay 44×44 and always need an accessible name. Compact text is for dense,
        non-hero UI.
      </p>
    </div>
    <div class="state-row">
      <DenButton size="icon" variant="tertiary" icon="back" ariaLabel="Back" />
      <DenButton size="icon" variant="tertiary" icon="more" ariaLabel="More actions" />
      <DenButton size="icon" variant="tertiary" icon="close" ariaLabel="Close" />
      <DenButton size="compact" icon="retry" label="Try again" />
      <DenButton size="compact" variant="tertiary" label="Cancel" />
      <DenButton size="compact" variant="device" icon="tv" label="This device" />
    </div>
  </section>
</main>

<style>
  :global(body) {
    min-width: 320px;
    background:
      radial-gradient(circle at 82% 2%, rgb(91 140 255 / 0.14), transparent 28rem), var(--bg);
  }

  main {
    display: grid;
    gap: 64px;
    width: min(1180px, calc(100% - 32px));
    margin: 0 auto;
    padding: 64px 0 96px;
  }

  h1,
  h2,
  h3,
  p {
    margin-top: 0;
  }

  h1 {
    max-width: 14ch;
    margin-bottom: 14px;
    font-size: clamp(40px, 7vw, 76px);
    line-height: 0.98;
    letter-spacing: -0.055em;
  }

  h2 {
    margin-bottom: 8px;
    font-size: clamp(24px, 3.2vw, 38px);
    line-height: 1.08;
    letter-spacing: -0.035em;
  }

  h3 {
    margin-bottom: 6px;
    font-size: 17px;
  }

  p {
    color: var(--muted);
  }

  .lede {
    max-width: 66ch;
    margin-bottom: 0;
    font-size: 18px;
  }

  .demo-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 12px 24px;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .material-picker {
    display: flex;
    gap: 4px;
    padding: 4px;
    border: 1px solid var(--line);
    border-radius: 13px;
    background: rgb(255 255 255 / 0.025);
  }

  .eyebrow {
    margin-bottom: 8px;
    color: #aac2ff;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .demo-toolbar .eyebrow {
    margin-bottom: 0;
  }

  .detail-stage {
    position: relative;
    min-height: 560px;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 24px;
    background: #14141a;
    isolation: isolate;
  }

  .art {
    position: absolute;
    inset: 0;
    z-index: -1;
    background:
      linear-gradient(90deg, #111218 8%, rgb(17 18 24 / 0.88) 38%, transparent 76%),
      linear-gradient(0deg, #111218 0%, transparent 46%),
      radial-gradient(ellipse at 79% 30%, #7891ab 0%, #38475c 23%, #1a2534 48%, #111218 74%);
  }

  .detail-copy {
    display: flex;
    min-height: 560px;
    max-width: 720px;
    flex-direction: column;
    justify-content: flex-end;
    padding: clamp(24px, 5vw, 64px);
  }

  .detail-copy h2 {
    margin-bottom: 4px;
    font-size: clamp(42px, 7vw, 72px);
  }

  .metadata {
    color: rgb(231 231 234 / 0.74);
  }

  .summary {
    max-width: 56ch;
  }

  .hero-actions,
  .state-row,
  .player-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
  }

  .notice {
    min-height: 1.4em;
    margin: 12px 2px 0;
    color: var(--muted);
    font-size: 14px;
  }

  .section-heading {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(260px, 0.75fr);
    gap: 32px;
    align-items: end;
    margin-bottom: 22px;
  }

  .section-heading h2,
  .section-heading p {
    margin-bottom: 0;
  }

  .spec-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
  }

  .spec-grid article,
  .menu-card {
    min-width: 0;
    padding: 22px;
    border: 1px solid var(--line);
    border-radius: 18px;
    background: rgb(255 255 255 / 0.025);
  }

  .spec-grid article > p {
    min-height: 2.8em;
    margin-bottom: 20px;
    font-size: 14px;
  }

  .surface-grid {
    display: grid;
    grid-template-columns: minmax(260px, 0.38fr) minmax(0, 1fr);
    gap: 16px;
  }

  .menu {
    display: grid;
    gap: 2px;
    padding: 6px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: #202026;
  }

  .player-card {
    display: flex;
    min-height: 310px;
    flex-direction: column;
    justify-content: space-between;
    overflow: hidden;
    padding: 24px;
    border: 1px solid var(--glass-edge);
    border-radius: 18px;
    background:
      linear-gradient(0deg, rgb(0 0 0 / 0.76), transparent 64%),
      radial-gradient(ellipse at 70% 20%, #846c68, #3e3a46 42%, #17171d 78%);
  }

  .player-copy h2 {
    font-size: 24px;
  }

  .player-time {
    flex: 1 1 120px;
    color: rgb(255 255 255 / 0.72);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }

  /* Alternative B: material belongs to bounded surfaces and controls, never the page or scrolling content.
     These panels provide depth around every family in the system; DenButton owns each control's material. */
  .material-glass {
    --material-edge: rgb(255 255 255 / 0.2);
    --material-fill: rgb(36 38 48 / 0.54);
    --material-shadow: 0 18px 55px rgb(0 0 0 / 0.32);
  }

  .material-glass .material-picker,
  .material-glass .spec-grid article,
  .material-glass .menu-card,
  .material-glass .menu {
    border-color: var(--material-edge);
    background: var(--material-fill);
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.11),
      var(--material-shadow);
    -webkit-backdrop-filter: blur(20px) saturate(145%);
    backdrop-filter: blur(20px) saturate(145%);
  }

  .material-glass .detail-stage {
    border-color: var(--material-edge);
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.1),
      0 28px 80px rgb(0 0 0 / 0.36);
  }

  .material-glass .player-card {
    border-color: rgb(255 255 255 / 0.24);
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.14),
      0 24px 60px rgb(0 0 0 / 0.38);
  }

  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .material-glass .material-picker,
    .material-glass .spec-grid article,
    .material-glass .menu-card,
    .material-glass .menu {
      background: #242630;
    }
  }

  @media (prefers-reduced-transparency: reduce) {
    .material-glass .material-picker,
    .material-glass .spec-grid article,
    .material-glass .menu-card,
    .material-glass .menu {
      background: #242630;
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
  }

  @media (width <= 720px) {
    main {
      gap: 48px;
      padding-top: 40px;
    }

    .detail-stage,
    .detail-copy {
      min-height: 610px;
    }

    .art {
      background:
        linear-gradient(0deg, #111218 8%, rgb(17 18 24 / 0.72) 54%, transparent 82%),
        radial-gradient(ellipse at 68% 18%, #7891ab 0%, #38475c 23%, #1a2534 48%, #111218 74%);
    }

    .hero-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .hero-actions :global(.primary) {
      grid-column: 1 / -1;
    }

    .hero-actions :global(button) {
      width: 100%;
    }

    .section-heading,
    .surface-grid {
      grid-template-columns: 1fr;
    }

    .spec-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (width <= 460px) {
    .detail-copy {
      padding: 22px;
    }

    .detail-copy h2 {
      font-size: 42px;
    }

    .spec-grid {
      grid-template-columns: 1fr;
    }

    .spec-grid article > p {
      min-height: 0;
    }

    .state-row :global(button:not(.icon)) {
      flex: 1 1 auto;
    }

    .player-card {
      min-height: 360px;
      padding: 18px;
    }

    .player-time {
      order: -1;
      flex-basis: 100%;
    }
  }
</style>
