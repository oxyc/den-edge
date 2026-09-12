<script lang="ts">
  let { label = 'Loading', page = false }: { label?: string; page?: boolean } = $props();
</script>
<div class="loading" class:page role="status" data-route-loading={page ? '' : undefined}>
  <span class="spinner" aria-hidden="true"></span>
  <span class="label">{label}</span>
</div>
<style>
  .loading { display:grid; place-items:center; min-height:80px; }
  .page { position:fixed; inset:0; z-index:8; pointer-events:none; }
  .spinner { width:28px; height:28px; border:3px solid rgb(255 255 255 / .18); border-top-color:var(--fg,#fff); border-radius:50%; animation:turn .75s linear infinite; }
  .label { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
  @keyframes turn { to { transform:rotate(360deg); } }
  @media (prefers-reduced-motion:reduce) { .spinner { animation:none; } }
</style>
