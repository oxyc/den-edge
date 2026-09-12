<script lang="ts">
  import { fetchWarnings, type Warning } from '../lib/contentWarnings';
  import type { TitleDetail } from '../lib/detail';
  let { detail, apiKey, categories }: { detail: TitleDetail; apiKey: string; categories: string[] } = $props();
  let content = $state<{ id: number; warnings: Warning[] } | null>(null);
  $effect(() => {
    const controller = new AbortController(); content = null;
    void fetchWarnings(detail, apiKey, categories, controller.signal).then((loaded) => { if (!controller.signal.aborted) content = loaded; });
    return () => controller.abort();
  });
</script>
{#if content?.warnings.length}
  <details>
    <summary>Content warnings · {content.warnings.length}</summary>
    <div class="warnings"><ul>{#each content.warnings as warning (warning.id)}<li>{warning.label}</li>{/each}</ul>
      <a href={`https://www.doesthedogdie.com/media/${content.id}`} target="_blank" rel="noopener noreferrer">Does the Dog Die?</a>
    </div>
  </details>
{/if}
<style>
  details { position:absolute; z-index:3; top:calc(var(--bar-space) + 16px); right:var(--gutter); max-width:calc(100% - 32px); color:var(--fg); font-size:13px; }
  summary { cursor:pointer; padding:8px 14px; background:#141418df; border:1px solid var(--line); border-radius:999px; }
  .warnings { position:absolute; top:44px; right:0; width:300px; max-width:calc(100vw - 32px); background:#1b1b21; border:1px solid var(--line); border-radius:12px; padding:16px; box-shadow:0 8px 30px #0008; }
  ul { margin:0 0 12px; padding-left:20px; } li + li { margin-top:8px; } a { color:var(--accent); }
  @media(max-width:759px) { details { top:12px; } }
</style>
