<script lang="ts">
  import DetailIcon from './DetailIcon.svelte';
  import type { TitleRow } from '../lib/wire';
  type Reaction = TitleRow['reaction']['value'];
  let { value, busy, onchange }: { value: Reaction; busy: boolean; onchange: (value: Reaction) => void } = $props();
  const options = [{ value: 'dislike', label: 'Not for me' }, { value: 'like', label: 'Like' }, { value: 'love', label: 'Love' }] as const;
</script>
<div class="reactions" aria-label="Your opinion">
  {#each options as option}
    <button class={option.value} class:on={value === option.value} aria-label={option.label} aria-pressed={value === option.value}
      disabled={busy} onclick={() => onchange(value === option.value ? null : option.value)}>
      <span class="glyph"><DetailIcon name={option.value} filled={value === option.value} /></span><span class="label">{option.label}</span>
    </button>
  {/each}
</div>
<style>
  .reactions { display:flex; gap:16px; margin:0 0 32px; }
  button { display:grid; justify-items:center; gap:4px; min-width:76px; border:0; padding:0; background:none; color:var(--muted); cursor:pointer; }
  .glyph { display:grid; place-items:center; width:52px; height:44px; border-radius:999px; }
  button:hover .glyph, button:focus-visible .glyph { background:#fff2; }
  button:focus-visible { outline:2px solid var(--accent); outline-offset:3px; border-radius:10px; }
  .label { font-size:12px; line-height:20px; }
  .dislike.on { color:#ffa251; } .like.on { color:#75d698; } .love.on { color:#ff6b80; }
  @media(max-width:759px) { .reactions { display:none; } }
</style>
