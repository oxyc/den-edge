import type { Vault, VaultChange } from './localVault';

const PAGE_SIZE = 64;
const LIBRARY_ID = /^[0-9a-f]{32}$/;
const CANDIDATE_REF = /^[0-9a-f]{64}$/;
const RECEIPT_VALUE = Uint8Array.of(1);

/**
 * Removes only the encrypted records written by the retired Web Owner-split implementation. One bounded page is
 * handled per foreground maintenance pass; a durable receipt keeps later sessions from scanning the prefix again.
 */
export class RetiredOwnerSplitRecords {
  readonly #prefix: string;
  readonly #receipt: string;
  #after?: string;
  #complete = false;

  constructor(
    private readonly vault: Vault,
    libraryId: string,
  ) {
    if (!LIBRARY_ID.test(libraryId)) throw new TypeError('Library identity is not canonical');
    this.#prefix = `${libraryId}:profile-migration/v1/`;
    this.#receipt = `${libraryId}:retired/profile-migration.v1`;
  }

  /** Whether this pass completed the cleanup. Failures remain retryable and disclose no stored key or value. */
  async run(): Promise<boolean> {
    if (this.#complete) return true;
    try {
      const receipt = await this.vault.get(this.#receipt);
      if (receipt?.length === 1 && receipt[0] === RECEIPT_VALUE[0]) {
        this.#complete = true;
        return true;
      }
      if (!this.vault.keys) throw new Error('Bounded Vault key enumeration is unavailable');
      const page = await this.vault.keys(this.#prefix, this.#after, PAGE_SIZE);
      const changes: VaultChange[] = page.flatMap((key) =>
        this.#retired(key) ? [{ kind: 'delete' as const, key }] : [],
      );
      const final = page.length < PAGE_SIZE;
      if (final) changes.push({ kind: 'put', key: this.#receipt, value: RECEIPT_VALUE });
      if (this.vault.commit) await this.vault.commit(changes);
      else {
        for (const change of changes) {
          if (change.kind === 'delete') await this.vault.delete(change.key);
          else await this.vault.put(change.key, change.value);
        }
      }
      if (final) this.#complete = true;
      else this.#after = page.at(-1);
      return this.#complete;
    } catch {
      // A later maintenance pass retries. Stored key names and adapter errors stay out of diagnostics.
      console.warn('den: retired browser migration storage cleanup will be retried');
      return false;
    }
  }

  #retired(key: string): boolean {
    const suffix = key.slice(this.#prefix.length);
    return (
      key.startsWith(this.#prefix) &&
      (suffix === 'state' ||
        (suffix.startsWith('candidate/') && CANDIDATE_REF.test(suffix.slice('candidate/'.length))))
    );
  }
}
