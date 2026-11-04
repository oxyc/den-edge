import { expect, test } from 'vitest';
import { noteLibraryFold, resetLibraryStartupMetrics } from './libraryStartupMetrics';

test('records Tizen 3 fallback folds separately without changing the shared fold budget', () => {
  resetLibraryStartupMetrics();
  noteLibraryFold(10, 2);
  noteLibraryFold(5, 3, true);
  expect(globalThis.__denLibraryStartupMetrics).toMatchObject({
    documentsFolded: 15,
    foldMs: 5,
    fallbackDocumentsFolded: 5,
    fallbackFoldMs: 3,
  });
});
