// Posters' standings in a real browser: one effect per title stands in for one card's badge, and counts how often
// each was woken. `fixtureStandings(entries)` hands over a whole new map, as the library does on every change.
import { flushSync } from 'svelte';
import type { Standing } from '../src/lib/library';
import { libraryStandings } from '../src/lib/standing.svelte';

const woken: Record<string, number> = {};
const ids = Array.from({ length: 200 }, (_, id) => id + 1);

$effect.root(() => {
  for (const id of ids)
    $effect(() => {
      libraryStandings.of({ type: 'movie', id });
      woken[`movie:${id}`] = (woken[`movie:${id}`] ?? 0) + 1;
    });
});

Object.assign(window, {
  fixtureStandings(entries: Array<[string, Standing]>) {
    libraryStandings.set(new Map(entries));
    flushSync();
    return { ...woken };
  },
});
document.body.dataset.ready = 'true';
