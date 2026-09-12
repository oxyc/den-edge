<script lang="ts">
  import icon from '../assets/den-mark.png';
  import { navigateBack } from '../lib/navigation';
  import type { Route } from '../lib/route';
  let { route, paired }: { route: Route; paired: boolean } = $props();
  const tabs = [
    {page:'library',label:'Home'}, {page:'movies',label:'Movies'},
    {page:'series',label:'Series'}, {page:'settings',label:'Settings'},
  ] as const;
</script>

<header class="bar glass">
  <div class="leading">
    <a class="brand" href="#library" aria-label="Den home"><img src={icon} width="54" height="32" alt="" /></a>
    {#if paired && (route.page === 'title' || route.page === 'person')}
      <button class="back" type="button" onclick={navigateBack} aria-label="Back">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m14 5-7 7 7 7" /></svg>
        Back
      </button>
    {/if}
  </div>
  {#if paired}
    <nav aria-label="Main navigation">
      {#each tabs as tab (tab.page)}
        <a href="#{tab.page}" aria-current={route.page === tab.page ? 'page' : undefined}>{tab.label}</a>
      {/each}
    </nav>
  {/if}
</header>

<style>
  .bar {
    position:fixed;
    top:max(12px, env(safe-area-inset-top));
    right:var(--gutter);
    left:var(--gutter);
    z-index:10;
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:12px;
    min-height:46px;
    padding:6px 12px;
    border-radius:999px;
  }
  .leading { display:flex; align-items:center; gap:12px; }
  .brand { display:flex; flex-shrink:0; width:54px; height:32px; overflow:hidden; }
  .brand img { display:block; width:54px; height:32px; object-fit:contain; transform:scale(2.2); }
  .back { display:flex; align-items:center; gap:4px; min-height:32px; padding:0 8px; border:0; border-radius:8px; background:transparent; color:var(--fg); cursor:pointer; }
  .back:hover { background:rgb(255 255 255 / .08); }
  .back svg { fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
  nav { display:flex; gap:clamp(12px,3vw,24px); }
  nav a { color:var(--muted); font-weight:600; text-decoration:none; }
  nav a[aria-current='page'] { color:var(--fg); }
  @media(max-width:759px) {
    .back { display:none; }
    .bar { gap:8px; }
    .brand, .brand img { width:48px; }
    nav { gap:clamp(8px,2vw,12px); font-size:14px; }
  }
</style>
