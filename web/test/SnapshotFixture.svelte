<script lang="ts">
 import RoutePage from '../src/components/RoutePage.svelte';
 import '../src/app.css';
</script>
<main style="padding:100px 20px;max-width:1400px;margin:0 auto">
 <RoutePage active={true}>
  <section class="hero" style="margin-top:-100px;height:600px;background:#468">
   <h1 class="animated" style="margin:0">Snapshot geometry</h1>
   <div class="rail" style="display:flex;overflow:auto;width:100%;height:80px">
    {#each Array(12) as _, i}<div style="flex:0 0 160px">{i}</div>{/each}
   </div>
  </section>
  <div style="height:2000px">Rows</div>
 </RoutePage>
</main>

<style> .animated { animation: drift 2s linear infinite alternate; } @keyframes drift { from { transform:translateX(0);opacity:.5; } to { transform:translateX(40px);opacity:1; } } </style>
