import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const STATIC_IMPORT =
  /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^'"]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const SUFFIXES = ['', '.ts', '.svelte', '.svelte.ts', '.js', '/index.ts'];

function resolveImport(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(from), specifier);
  return SUFFIXES.map((suffix) => base + suffix).find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
}

const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Every module `entries` reach through static imports; with `dynamic`, through `import()` as well, which is how every
 * module the app can ever load is found.
 */
function reach(entries: string[], dynamic = false): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(?:ts|svelte)$/.test(file)) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const next = resolveImport(file, (match[1] ?? match[2])!);
      if (next) queue.push(next);
    }
    if (dynamic)
      for (const match of source.matchAll(DYNAMIC_IMPORT)) {
        const next = resolveImport(file, match[1]!);
        if (next) queue.push(next);
      }
  }
  return seen;
}

/** The modules some `import()` loads on its own. */
function dynamicTargets(files: Set<string>): Set<string> {
  const targets = new Set<string>();
  for (const file of files) {
    if (!/\.(?:ts|svelte)$/.test(file)) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(DYNAMIC_IMPORT)) {
      const target = resolveImport(file, match[1]!);
      if (target) targets.add(target);
    }
  }
  return targets;
}

/** What `App.svelte` loads without the library: the pairing screen and the dialogs it opens on its own. */
const WITHOUT_LIBRARY = [
  'LinkTV.svelte',
  'components/InviteDialog.svelte',
  'components/PhoneDialog.svelte',
  'components/ConnectDialog.svelte',
  'components/LibraryRetirementNotice.svelte',
];

/**
 * The modules only the library reaches: what `RoutedLibrary` imports statically that nothing an unpaired start loads
 * does. Grouped into one chunk, they load together once a browser opens its library rather than as the dozen small
 * shared chunks the automatic split makes of what Home, Detail and Search have in common.
 *
 * A module some `import()` loads by itself stays out of the group, in a chunk of its own: rolldown wrote the
 * namespace object of one that was grouped (`RoutedLibrary`, in the TV builds) into a chunk that never defined it, and
 * the app stopped at "Starting Den…" on a `RoutedLibrary_exports is not defined`.
 */
export function libraryModules(
  src: string,
  tv = false,
): { library: Set<string>; startup: Set<string> } {
  // The TV's entry is its own module, and imports the library service directly: that is first paint there.
  const entry = [tv ? 'tv/main.ts' : 'main.ts', 'appMain.ts'].map((file) => resolve(src, file));
  const roots = [...entry, ...WITHOUT_LIBRARY.map((file) => resolve(src, file))];
  const initial = reach(entry);
  const unpaired = reach(roots);
  const library = reach([resolve(src, 'RoutedLibrary.svelte')]);
  const lazy = dynamicTargets(reach([...roots, resolve(src, 'RoutedLibrary.svelte')], true));
  const without = (set: Set<string>, ...others: Set<string>[]) =>
    new Set([...set].filter((id) => !lazy.has(id) && others.every((other) => !other.has(id))));
  return {
    library: without(library, unpaired),
    // What the library shares with the first paint is named a chunk of its own, so the first paint's import of it
    // never lands in the library's chunk and drags that along.
    startup: new Set([...without(library)].filter((id) => initial.has(id))),
  };
}
