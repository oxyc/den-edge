import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { libraryModules } from './libraryModules.ts';

const src = fileURLToPath(new URL('../src/', import.meta.url));
const at = (file: string) => `${src}${file}`;

describe.each([false, true])('libraryModules (tv: %s)', (tv) => {
  const { library, startup } = libraryModules(src.replace(/\/$/, ''), tv);

  it('groups what only the library reaches', () => {
    expect(library.has(at('Library.svelte'))).toBe(true);
  });

  it('keeps the pairing screen, the entry and the app module out of the library', () => {
    for (const file of ['LinkTV.svelte', 'appMain.ts', 'App.svelte', 'lib/links.svelte.ts'])
      expect(library.has(at(file)), file).toBe(false);
  });

  it('leaves a module some import() loads on its own out of both groups', () => {
    expect(library.has(at('RoutedLibrary.svelte'))).toBe(false);
    expect(startup.has(at('RoutedLibrary.svelte'))).toBe(false);
  });

  it('never puts a module in both groups', () => {
    for (const id of startup) expect(library.has(id), id).toBe(false);
  });
});

describe('the TV entry', () => {
  it('counts the library service it imports as first paint', () => {
    const { library, startup } = libraryModules(src.replace(/\/$/, ''), true);
    expect(library.has(at('lib/libraryWorkerStart.ts'))).toBe(false);
    expect(startup.has(at('lib/libraryWorkerStart.ts'))).toBe(true);
  });
});
