<script lang="ts">
  import { untrack } from 'svelte';
  import ChipSelect from './ChipSelect.svelte';

  let {
    tabs,
    value,
    label,
    one,
    panel,
    href,
    onchange,
  }: {
    /** `option` is the tab's name in the picker, where it can say more than a chip has room for. */
    tabs: { value: string; label: string; option?: string }[];
    value: string;
    label: string;
    /** What one tab is ("Season"): the picker's name, read out in place of the tab list's. */
    one: string;
    panel: string;
    /**
     * Where each tab lives. A tab is a link, so it opens in a new tab like any other; a plain click is the Router's,
     * which follows it in place (`Router.svelte`), and a modified or middle click is the browser's.
     */
    href: (value: string) => string;
    /** A tab chosen from the keyboard's arrows, Home and End, or from the picker; Enter follows the link itself. */
    onchange: (value: string) => void;
  } = $props();

  /**
   * How much room the chips must have to spare before a picker turns back into them. Wider than a classic
   * scrollbar (15–17px), which can come and go as the page's height changes, so neither that nor a width right at
   * the edge switches the two back and forth.
   */
  const MARGIN = 24;

  /**
   * Chips while they fit on one line, one picker where they do not; undefined until measured. The chips stay in the
   * page either way, out of sight and out of reach while the picker shows, so their own width is always there to
   * measure — it depends only on their names, not on which form is showing, and so the switch cannot feed itself.
   */
  let collapsed = $state<boolean | undefined>();
  let root = $state<HTMLElement>();
  let row = $state<HTMLElement>();

  $effect(() => {
    const [node, chips] = [root, row];
    const parent = node?.parentElement;
    if (!parent || !chips) return;
    // The chips may take the whole width of what they sit in, so that is the room; it does not change with them.
    const decide = () => {
      const style = getComputedStyle(parent);
      const room =
        parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const natural = chips.getBoundingClientRect().width;
      // A page out of sight has no width to go by; it decides when it is shown.
      if (room <= 0 || natural <= 0) return;
      collapsed = collapsed ? natural > room - MARGIN : natural > room;
    };
    // Decided here, before the first paint, so a series that needs the picker never shows its chips first.
    untrack(decide);
    // A resize switches on the next frame: switching changes the height of what is observed, which within the same
    // frame would be a second round of observations the browser reports as a loop.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(decide);
    });
    observer.observe(parent);
    observer.observe(chips);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  });

  const current = $derived(tabs.find((tab) => tab.value === value));

  function keyboard(event: KeyboardEvent, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : event.key === 'ArrowRight'
            ? (index + 1) % tabs.length
            : event.key === 'ArrowLeft'
              ? (index + tabs.length - 1) % tabs.length
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const tab = event.currentTarget as HTMLAnchorElement;
    (tab.parentElement?.children[next] as HTMLAnchorElement)?.focus({ preventScroll: true });
    onchange(tabs[next]!.value);
  }
</script>

<div class="switch" bind:this={root}>
  <div
    class="measure"
    class:on={collapsed !== false}
    aria-hidden={collapsed !== false || undefined}
  >
    <div
      class="tabs"
      class:many={tabs.length > 6}
      role="tablist"
      aria-label={label}
      bind:this={row}
    >
      {#each tabs as tab, i (tab.value)}
        <a
          href={href(tab.value)}
          role="tab"
          id={`${panel}-tab-${i}`}
          aria-controls={panel}
          aria-selected={value === tab.value}
          tabindex={value === tab.value ? 0 : -1}
          class:on={value === tab.value}
          onkeydown={(e) => keyboard(e, i)}>{tab.label}</a
        >
      {/each}
    </div>
  </div>
  {#if collapsed}
    <div class="tabs" class:many={tabs.length > 6}>
      <ChipSelect
        class="season-picker"
        label={one}
        text={current?.label ?? ''}
        {value}
        options={tabs.map((tab) => ({ value: tab.value, label: tab.option ?? tab.label }))}
        round={tabs.length > 6}
        {onchange}
      />
    </div>
  {/if}
</div>

<style>
  .switch {
    position: relative;
  }

  /* The chips' own width, kept measurable while they are not shown: unseen, unreachable, and clipped to nothing so
     they cannot widen the page. */
  .measure.on {
    position: absolute;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    overflow: hidden;
    visibility: hidden;
    pointer-events: none;
  }

  .tabs {
    display: flex;
    width: max-content;
    gap: 4px;
    padding: 4px;
    margin-bottom: 24px;
    border-radius: 14px;
    background: rgb(255 255 255 / 0.07);
  }

  a {
    display: flex;
    flex: 1 0 auto;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 8px 20px;
    border: 0;
    border-radius: 10px;
    background: none;
    color: var(--muted);
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
    white-space: nowrap;
  }

  a.on {
    color: var(--fg);
    background: rgb(255 255 255 / 0.16);
    box-shadow: 0 1px 6px #0003;
  }

  a:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .many {
    gap: 8px;
    padding: 3px;
    background: none;
  }

  .many a {
    border: 1px solid var(--line);
    border-radius: 999px;
  }

  @media (width <= 759px) {
    a {
      padding-inline: 16px;
    }
  }
</style>
