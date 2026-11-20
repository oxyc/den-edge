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

/** Every module `entry` reaches through static imports (dynamic `import()` is not followed). */
function reach(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(?:ts|svelte)$/.test(file)) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) {
      const next = resolveImport(file, (match[1] ?? match[2])!);
      if (next) queue.push(next);
    }
  }
  return seen;
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
 */
export function libraryModules(src: string): Set<string> {
  const startup = reach(
    ['main.ts', 'appMain.ts', ...WITHOUT_LIBRARY].map((file) => resolve(src, file)),
  );
  return new Set(
    [...reach([resolve(src, 'RoutedLibrary.svelte')])].filter((id) => !startup.has(id)),
  );
}
