import { SvelteMap } from 'svelte/reactivity';

/** Each library model's first read from den-edge while it runs, 0–1. */
const reading = new SvelteMap<object, number>();

/** `owner`'s first read is at `progress`; null (or 1) once it has finished, failed or closed. */
export function noteLibraryOpening(owner: object, progress: number | null): void {
  if (progress === null || progress >= 1) reading.delete(owner);
  else reading.set(owner, progress);
}

/** How far the slowest first read is, for the navigation bar's progress line; null when none is running. */
export function libraryOpeningProgress(): number | null {
  return reading.size ? Math.min(...reading.values()) : null;
}
