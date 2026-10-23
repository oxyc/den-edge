import { expect, test } from '@playwright/test';

test('two tabs publish saved views atomically without Web Locks', async ({ context, page }) => {
  await context.addInitScript(() =>
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }),
  );
  const second = await context.newPage();
  for (const tab of [page, second]) {
    await tab.goto('/test/router.html');
    await tab.evaluate(async () => {
      const { indexedVault } = await import('/src/lib/localVault.ts');
      const { deriveKeys } = await import('/src/lib/wire.ts');
      const {
        FINISHED_LIBRARY_POLICY,
        FINISHED_LIBRARY_RECOMMENDATIONS,
        readFinishedLibraryViews,
        writeFinishedLibraryViews,
      } = await import('/src/lib/finishedLibraryViews.ts');
      const raw = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
      const key = btoa(String.fromCharCode(...raw));
      const id = (await deriveKeys(raw)).id;
      const vault = indexedVault(indexedDB);
      if (!vault.compareAndCommit) throw new Error('IndexedDB must support conditional publication');
      window.savedViewRace = {
        vault,
        read: () => readFinishedLibraryViews(key, vault, ['watchlist', 'continue']),
        pieces: () => vault.entries(`${id}:finished-views.v1:`),
        write: (head, target = vault) =>
          writeFinishedLibraryViews(key, target, {
            schema: 1,
            identity: {
              libraryId: id,
              generation: 'generation',
              head,
              authorityRevision: `revision-${head}`,
              policyVersion: FINISHED_LIBRARY_POLICY,
              rowsVersion: head,
              layoutVersion: 'facts',
              recommendationVersion: FINISHED_LIBRARY_RECOMMENDATIONS,
              reconsiderAt: null,
            },
            pieces: {
              watchlist: { titles: [{ type: 'movie', id: head }] },
              continue: { view: { kind: 'continue', items: [], needsShapes: [] }, layouts: {} },
            },
          }),
      };
    });
  }
  expect(await page.evaluate(() => window.savedViewRace.write(1))).toBe(true);

  // Pause before the first tab's actual transaction, after it prepared an update against the old manifest.
  await page.evaluate(async () => {
    const race = window.savedViewRace;
    let reached;
    const blocked = new Promise((resolve) => (reached = resolve));
    const release = new Promise((resolve) => (race.release = resolve));
    race.pending = race.write(2, {
      ...race.vault,
      compareAndCommit: async (...args) => {
        reached();
        await release;
        return race.vault.compareAndCommit(...args);
      },
    });
    await blocked;
  });
  expect(await second.evaluate(() => window.savedViewRace.write(3))).toBe(true);
  expect(
    await page.evaluate(async () => {
      window.savedViewRace.release();
      return window.savedViewRace.pending;
    }),
  ).toBe(false);

  for (const tab of [page, second]) {
    expect(await tab.evaluate(() => window.savedViewRace.read())).toMatchObject({
      identity: { head: 3 },
      pieces: {
        watchlist: { titles: [{ type: 'movie', id: 3 }] },
        continue: { view: { items: [] } },
      },
    });
    expect(await tab.evaluate(async () => (await window.savedViewRace.pieces()).length)).toBe(2);
  }
});
