import { test } from 'vitest';
import { emptyLibrary, withDisplay, type Library, type Title } from './library';
import { LibrarySession } from './librarySession.svelte';

const TITLES = 5_000;
const BATCHES = 50;
const projection: Library = {
  ...emptyLibrary(),
  records: Array.from({ length: TITLES }, (_, id) => ({
    title: { type: 'movie' as const, id, title: '' },
    status: 'watched' as const,
    progress: 0,
    progressAt: id,
    addedAt: id,
    deleted: false,
  })),
};
const names: Title[] = Array.from({ length: BATCHES }, (_, id) => ({
  type: 'movie',
  id,
  title: `Movie ${id}`,
}));

test('initial display projection (5,000 records)', async ({ bench }) => {
  const session = new LibrarySession(null);
  session.publishLibraryMetadata(names, []);
  const whole = bench('whole-library initial projection', () =>
    withDisplay({ ...projection }, names),
  );
  const indexed = bench('indexed initial projection', () =>
    session.displayedLibrary({ ...projection }),
  );
  await bench.compare(whole, indexed);
});

test('late library metadata publication (5,000 records, 50 one-title batches)', async ({
  bench,
}) => {
  const whole = bench('whole-library remap', () => {
    let displays: Title[] = [];
    for (const title of names) {
      displays = [...displays, title];
      withDisplay(projection, displays);
    }
  });

  const incremental = bench('keyed incremental publication', () => {
    const session = new LibrarySession(null);
    session.displayedLibrary(projection);
    for (const title of names) {
      session.publishLibraryMetadata([title], []);
      session.displayedLibrary(projection);
    }
  });
  await bench.compare(whole, incremental);
});
