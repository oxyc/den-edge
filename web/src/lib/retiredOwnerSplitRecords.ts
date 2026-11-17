import type { Vault, VaultChange } from './localVault';

const PAGE_SIZE = 64;
const LIBRARY_ID = /^[0-9a-f]{32}$/;
const RETIRED_RECORD = /^(?:state|candidate\/[0-9a-f]{64})$/;
const RECEIPT_VALUE = Uint8Array.of(1);

/**
 * Removes only the encrypted records written by the retired Web Owner-split implementation. One bounded page is
 * handled per foreground maintenance pass. Null means a durable receipt now keeps later sessions from scanning.
 */
export async function purgeRetiredOwnerSplitRecords(
  vault: Vault,
  libraryId: string,
  after?: string,
): Promise<string | null> {
  if (!LIBRARY_ID.test(libraryId)) throw new TypeError('Library identity is not canonical');
  const prefix = `${libraryId}:profile-migration/v1/`;
  const receiptKey = `${libraryId}:retired/m1`;
  const receipt = after === undefined && (await vault.get(receiptKey));
  if (receipt && receipt.length === 1 && receipt[0] === RECEIPT_VALUE[0]) return null;
  if (!vault.page || !vault.commit) throw new Error('Atomic bounded Vault cleanup is unavailable');
  const page = await vault.page(prefix, after, PAGE_SIZE);
  const changes: VaultChange[] = page.flatMap(([key]) =>
    key.startsWith(prefix) && RETIRED_RECORD.test(key.slice(prefix.length))
      ? [{ kind: 'delete' as const, key }]
      : [],
  );
  if (page.length < PAGE_SIZE) changes.push({ kind: 'put', key: receiptKey, value: RECEIPT_VALUE });
  await vault.commit(changes);
  return page.length < PAGE_SIZE ? null : page.at(-1)![0];
}
