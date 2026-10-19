<script lang="ts">
  let {
    tabs,
    value,
    label,
    panel,
    href,
    onchange,
  }: {
    tabs: { value: string; label: string }[];
    value: string;
    label: string;
    panel: string;
    /**
     * Where each tab lives. A tab is a link, so it opens in a new tab like any other; a plain click is the Router's,
     * which follows it in place (`Router.svelte`), and a modified or middle click is the browser's.
     */
    href: (value: string) => string;
    /** A tab chosen from the keyboard's arrows, Home and End; Enter follows the link itself. */
    onchange: (value: string) => void;
  } = $props();
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

<div class="tabs" class:many={tabs.length > 6} role="tablist" aria-label={label}>
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

<style>
  .tabs {
    display: flex;
    width: fit-content;
    max-width: 100%;
    gap: 4px;
    padding: 4px;
    margin-bottom: 24px;
    overflow-x: auto;
    scrollbar-width: none;
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
