// What `Router` does only on a touch screen: copy a page left (`pageSnapshot.ts`) and Den's own edge swipe between
// pages (`swipeBack.ts`), loaded once a touch screen mounts the router. Without touch none of it ever runs: function
// coverage of a desktop Home load called none of pageSnapshot, swipeBack or LoadingSnapshot, and leaving them out of
// the startup graph took 8.4 KB (2.7 KB gzip) off it.
export { capturePage, prepareSwipeLanding, previewHistory } from './pageSnapshot';
export { browserSwipesBack, swipeHistory } from './swipeBack';
export { default as LoadingSnapshot } from '../components/LoadingSnapshot.svelte';
