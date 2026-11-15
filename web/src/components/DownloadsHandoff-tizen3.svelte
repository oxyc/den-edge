<script lang="ts">
  import type { LibraryModel } from '../lib/libraryModel.svelte';
  import { i18n } from '../lib/i18n.svelte';

  // Keep the lazy screen's production contract aligned with DownloadsPage. These values are intentionally unused:
  // reduced Tizen is a viewer-only handoff and must not acquire or mutate the household download model.
  let { model: _model, active: _active = true }: { model?: LibraryModel; active?: boolean } =
    $props();
</script>

<h1>{i18n.phrase('Downloads')}</h1>
<p class="note">{i18n.phrase('Manage downloads in a supported browser')}</p>
<p class="note">
  {i18n.phrase('On a phone or computer linked to this household, open Den › Downloads.')}
</p>
<p class="note">{`${__DEN_TV_WEB_ORIGIN__ || location.origin}/downloads`}</p>

<style>
  .note {
    color: var(--muted);
  }
</style>
