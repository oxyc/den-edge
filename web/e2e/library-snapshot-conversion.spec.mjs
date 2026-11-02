import { expect, test } from '@playwright/test';

// A library this browser kept before the snapshot layout, one sealed IndexedDB record per document, opens in the
// browser as a returning visit opens it (`LibraryLog.open`, offline here): every document is there, converted once
// into one snapshot, and the old records are gone.
test('a library kept one record per document opens whole, converted into one snapshot', async ({
  page,
}) => {
  await page.goto('/test/router.html');
  const result = await page.evaluate(async () => {
    const { indexedVault } = await import('/src/lib/localVault.ts');
    const { libraryLocalMaterials, sealLibraryLocalValue } =
      await import('/src/lib/libraryLocalValue.ts');
    const { deriveKeys, rowKey } = await import('/src/lib/wire.ts');
    const { ensureSyncPolicy } = await import('/src/lib/syncLoader.ts');
    const { LibraryLog } = await import('/src/lib/log.ts');
    await ensureSyncPolicy();
    const raw = Uint8Array.from({ length: 32 }, (_, index) => index + 11);
    const libraryKey = btoa(String.fromCharCode(...raw));
    const keys = await deriveKeys(raw);
    const vault = indexedVault(indexedDB);
    const { libraryId, key } = await libraryLocalMaterials(libraryKey);
    const put = async (name, value) =>
      vault.put(`${libraryId}:${name}`, await sealLibraryLocalValue(key, name, value));
    const stamp = (at) => [at, 0, 'aaaaaaaaaaaaaaaa'];
    const documents = Array.from({ length: 300 }, (_, index) => ({
      format: 4,
      kind: 'title',
      title: { type: 'movie', id: 1000 + index },
      status: { value: index % 2 ? 'watched' : 'watchlist', at: stamp(10_000 + index) },
      addedAt: 5_000 + index,
    }));
    documents.push({
      format: 4,
      kind: 'season',
      title: { type: 'tv', id: 77 },
      season: 1,
      seasonReset: null,
      episodes: {
        1: {
          progress: { value: 1, at: stamp(20_000), viewing: 0 },
          imported: false,
          plays: { 0: 20_000 },
          cleared: null,
        },
      },
    });
    const names = documents.map((document) =>
      document.kind === 'title'
        ? `title:movie:${document.title.id}`
        : `season:tv:${document.title.id}:${document.season}`,
    );
    for (const [index, document] of documents.entries())
      await put(`library-facts.v1:generation-e2e:document:${await rowKey(keys, names[index])}`, {
        schema: 1,
        seq: index + 1,
        value: 'ciphertext',
        row: document,
      });
    await put('library-facts.v1:manifest', {
      schema: 1,
      generation: 'generation-e2e',
      head: documents.length,
      rowsVersion: documents.length,
      revision: 'earlier-build',
      complete: true,
      profileTopology: false,
    });

    const stored = async () =>
      (await vault.entries(`${libraryId}:library-facts.v1:generation-e2e:`)).map(([name]) =>
        name.slice(libraryId.length + 1),
      );
    const offline = async () => Promise.reject(new TypeError('offline'));
    const open = async () => {
      const log = await LibraryLog.open(libraryKey, offline, undefined, vault);
      const held = log.documents().length;
      const watched = log.title({ type: 'movie', id: 1001 })?.status.value;
      const season = log.documentNamed('season:tv:77:1') !== undefined;
      log.close();
      return { held, watched, season };
    };
    const first = await open();
    const after = await stored();
    const second = await open();
    return {
      first,
      second,
      records: after.filter((name) => name.includes(':document:')).length,
      snapshots: after.filter((name) => name.endsWith(':snapshot')).length,
    };
  });
  expect(result.first).toEqual({ held: 301, watched: 'watched', season: true });
  expect(result.second).toEqual(result.first);
  expect(result.records).toBe(0);
  expect(result.snapshots).toBe(1);
});
