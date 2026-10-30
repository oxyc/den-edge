// Keep the entry tiny enough for a retained parser-time hero to paint before Svelte evaluates and mounts. The
// application module is preloaded from index.html, so this changes CPU admission rather than adding a network chain.
import './app.css';
import { openingLibraryIdentity } from './lib/openingLibraryIdentity';
import { beginStartupRenderPhase, startupMark } from './lib/startupTiming';

// A synced preference is authoritative once its profile opens. Until then, keep a warm non-English return visit
// from painting the build-time English navigation shell: appMain reads the matching cached catalog synchronously.
try {
  const marker = JSON.parse(localStorage.getItem('den.profile.active.v1') ?? 'null');
  const id =
    marker?.mode === 'persistent'
      ? marker.profileId
      : marker?.mode === 'visitor'
        ? (marker.visitorNamespace ?? marker.visitId)
        : null;
  const scope = id
    ? `${marker.mode === 'persistent' ? 'profile' : 'visitor'}-${id}`
    : marker?.mode === 'owner'
      ? 'owner'
      : 'default';
  const language =
    localStorage.getItem(`den.interfaceLanguage.presentation.v2.${scope}`) ??
    localStorage.getItem('den.interfaceLanguage.presentation.v1');
  if (language === 'es' || language === 'sv') {
    document.documentElement.lang = language;
    document.documentElement.dataset.denCachedInterfaceLanguage = language;
  }
} catch {
  // Storage can be unavailable; the ordinary English shell remains the safe fallback.
}

startupMark('page boot');
// Desktop used to fetch and compile its DedicatedWorker beside the app module. Preserve that overlap for a browser
// which already has a library to open, without constructing an authority before its exact shared identity is known.
if (!__DEN_TV__ && !import.meta.env.DEN_E2E) {
  const openingLibrary = openingLibraryIdentity();
  if (openingLibrary && typeof SharedWorker !== 'undefined')
    void import('./lib/libraryServiceSharedWorkerTransport')
      .then(({ prewarmSharedLibraryWorker }) => prewarmSharedLibraryWorker(openingLibrary))
      .catch(() => undefined);
}
const start = () => {
  const bootstrapFinished = beginStartupRenderPhase('bootstrap');
  const importFinished = beginStartupRenderPhase('app_import');
  startupMark('app module requested');
  const finished = () => {
    importFinished();
    bootstrapFinished();
  };
  void import('./appMain').then(finished, finished);
};
const retainedHero = document.querySelector(
  '[data-den-early-billboard]:not([hidden]) [data-den-early-backdrop][data-path]',
);

// A hidden document gets no animation frames — a tab opened in the background, an occluded window — so waiting for
// two would hold the whole app until it is shown; there is no paint to make room for then.
if (retainedHero && document.visibilityState === 'visible') {
  // Two animation frames guarantee one rendering opportunity between this bootstrap and application evaluation.
  requestAnimationFrame(() => requestAnimationFrame(start));
} else start();
