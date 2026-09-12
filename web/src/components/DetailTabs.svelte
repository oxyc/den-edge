<script lang="ts">
  let { tabs, value, label, panel, onchange }: {
    tabs: { value: string; label: string }[]; value: string; label: string; panel: string; onchange: (value: string) => void;
  } = $props();
  function keyboard(event: KeyboardEvent, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const button = event.currentTarget as HTMLButtonElement;
    (button.parentElement?.children[next] as HTMLButtonElement)?.focus({ preventScroll: true });
    onchange(tabs[next]!.value);
  }
</script>

<div class="tabs" class:many={tabs.length > 6} role="tablist" aria-label={label}>
  {#each tabs as tab, i (tab.value)}
    <button type="button" role="tab" id={`${panel}-tab-${i}`} aria-controls={panel} aria-selected={value === tab.value}
      tabindex={value === tab.value ? 0 : -1} class:on={value === tab.value}
      onclick={() => onchange(tab.value)} onkeydown={(e) => keyboard(e, i)}>{tab.label}</button>
  {/each}
</div>

<style>
  .tabs { display:flex; width:fit-content; max-width:100%; gap:4px; padding:4px; margin-bottom:24px; overflow-x:auto;
    scrollbar-width:none; border-radius:14px; background:rgb(255 255 255 / .07); }
  button { flex:1 0 auto; min-height:44px; padding:8px 20px; border:0; border-radius:10px; background:none;
    color:var(--muted); font-weight:600; cursor:pointer; white-space:nowrap; }
  button.on { color:var(--fg); background:rgb(255 255 255 / .16); box-shadow:0 1px 6px #0003; }
  button:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
  .many { gap:8px; padding:3px; background:none; }
  .many button { border:1px solid var(--line); border-radius:999px; }
  @media(max-width:759px) { button { padding-inline:16px; } }
</style>
