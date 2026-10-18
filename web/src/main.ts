// Keep the entry tiny enough for a retained parser-time hero to paint before Svelte evaluates and mounts. The
// application module is preloaded from index.html, so this changes CPU admission rather than adding a network chain.
import './app.css';
import { startupMark } from './lib/startupTiming';

startupMark('page boot');

const start = () => {
  startupMark('app module requested');
  void import('./appMain');
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
