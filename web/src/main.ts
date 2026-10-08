// Keep the entry tiny enough for a retained parser-time hero to paint before Svelte evaluates and mounts. The
// application module is preloaded from index.html, so this changes CPU admission rather than adding a network chain.
import './app.css';

const start = () => void import('./appMain');
const retainedHero = document.querySelector(
  '[data-den-early-billboard]:not([hidden]) [data-den-early-backdrop][data-path]',
);

if (retainedHero) {
  // Two animation frames guarantee one rendering opportunity between this bootstrap and application evaluation.
  requestAnimationFrame(() => requestAnimationFrame(start));
} else start();
