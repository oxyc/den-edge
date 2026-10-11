// `pair.ts`'s `join`, for `phoneLanding.svelte.ts` to import dynamically. Importing `pair.ts` itself dynamically made
// Rolldown (Vite 8.3) build a namespace object for it, since Settings and LinkTV import it statically, and place its
// namespace helper in the `pair` chunk, which appMain then imported statically for its own: @noble/curves was back
// in the startup graph. A module nothing imports statically needs no namespace object, so the helper stays in appMain.
export { join } from './pair';
