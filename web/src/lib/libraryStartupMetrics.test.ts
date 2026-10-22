import { expect, it } from 'vitest';
import {
  noteFinishedViewCacheHit,
  noteFinishedViewPromotion,
  resetLibraryStartupMetrics,
} from './libraryStartupMetrics';

it('classifies a finished-view promotion as an authoritative startup', () => {
  resetLibraryStartupMetrics();
  noteFinishedViewCacheHit();
  noteFinishedViewPromotion('selection:downloads');

  expect(globalThis.__denLibraryStartupMetrics).toMatchObject({
    viewSource: 'authoritative',
    promotion: 'selection:downloads',
  });
});
