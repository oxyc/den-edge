import { libraryVault, type Vault } from './localVault';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import {
  libraryCacheId,
  libraryGenerationKey,
  libraryRetirementLock,
} from './libraryRetirementLease';

const RECEIPT_PREFIX = 'retirement:';
const FALLBACK_KEY = 'den.libraryRetirements';
const LOCK_WAIT_MS = 20_000;

export interface LibraryRetirementReceipt {
  readonly id: string;
  readonly token: string;
  readonly prefix: string;
  readonly requestedAt: number;
  readonly failure?: 'wait' | 'storage';
}

const encode = (receipt: LibraryRetirementReceipt) =>
  new TextEncoder().encode(JSON.stringify(receipt));
const generation = (value: Uint8Array | undefined): string | undefined => {
  if (!value) return undefined;
  const decoded = new TextDecoder().decode(value);
  return /^[0-9a-f-]{36}$/.test(decoded) ? decoded : undefined;
};
const validPrefix = (id: string, prefix: unknown): prefix is string =>
  prefix === `${id}:` ||
  (typeof prefix === 'string' && new RegExp(`^${id}@[0-9a-f-]{36}:$`).test(prefix));

const decode = (value: Uint8Array): LibraryRetirementReceipt | undefined => {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(value)) as Record<string, unknown>;
    if (
      typeof parsed.id === 'string' &&
      /^[0-9a-f]{32}$/.test(parsed.id) &&
      typeof parsed.token === 'string' &&
      validPrefix(parsed.id, parsed.prefix) &&
      typeof parsed.requestedAt === 'number' &&
      (parsed.failure === undefined || parsed.failure === 'wait' || parsed.failure === 'storage')
    )
      return parsed as unknown as LibraryRetirementReceipt;
  } catch {
    // A malformed private receipt cannot authorize a prefix deletion.
  }
  return undefined;
};

const fallbackRead = (storage?: Storage) => {
  try {
    storage ??= globalThis.localStorage;
    const parsed = JSON.parse(storage?.getItem(FALLBACK_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (value): value is LibraryRetirementReceipt =>
            !!value &&
            typeof value === 'object' &&
            /^[0-9a-f]{32}$/.test((value as LibraryRetirementReceipt).id) &&
            typeof (value as LibraryRetirementReceipt).token === 'string' &&
            validPrefix(
              (value as LibraryRetirementReceipt).id,
              (value as LibraryRetirementReceipt).prefix,
            ) &&
            typeof (value as LibraryRetirementReceipt).requestedAt === 'number',
        )
      : [];
  } catch {
    return [];
  }
};

const fallbackWrite = (
  receipts: readonly LibraryRetirementReceipt[],
  storage?: Storage,
): boolean => {
  try {
    storage ??= globalThis.localStorage;
    if (receipts.length) storage?.setItem(FALLBACK_KEY, JSON.stringify(receipts));
    else storage?.removeItem(FALLBACK_KEY);
    return !!storage;
  } catch {
    return false;
  }
};

const same = (left: LibraryRetirementReceipt, right: LibraryRetirementReceipt) =>
  left.id === right.id && left.token === right.token;
const receiptKey = (receipt: Pick<LibraryRetirementReceipt, 'id' | 'token'>) =>
  `${RECEIPT_PREFIX}${receipt.id}:${receipt.token}`;

/** Durable, cross-tab retirement outcomes. Receipts contain the derived cache id, never the revoked library key. */
export class LibraryRetirements {
  pending = $state.raw<LibraryRetirementReceipt[]>(fallbackRead());
  #running = new SvelteSet<string>();
  #channel?: BroadcastChannel;

  constructor(private readonly vault: Vault | null = libraryVault) {
    if (typeof window === 'undefined') return;
    if (typeof BroadcastChannel !== 'undefined') {
      this.#channel = new BroadcastChannel('den-library-retirements');
      this.#channel.addEventListener('message', () => void this.refresh(false));
    }
    window.addEventListener('storage', (event) => {
      if (event.key === FALLBACK_KEY || event.key === null) void this.refresh(false);
    });
    window.addEventListener('online', () => this.retry());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.refresh(true);
    });
    // Queue the exclusive fence from the synchronous fallback before App can relink and start a new Worker. IndexedDB
    // reconciliation follows; waiting for its open first would let a reload's shared Worker lease overtake cleanup.
    this.retry();
    void this.refresh(false);
  }

  async prepare(libraryKey: string): Promise<LibraryRetirementReceipt | null> {
    if (!this.vault) return null;
    const id = await libraryCacheId(libraryKey);
    const prepare = async () => {
      const token = crypto.randomUUID();
      const requestedAt = Date.now();
      const generationKey = libraryGenerationKey(id);
      let oldGeneration: string | undefined;
      const known = new SvelteMap(fallbackRead().map((receipt) => [receiptKey(receipt), receipt]));
      let receipt: LibraryRetirementReceipt | undefined;
      let vaultKept = false;
      if (this.vault!.rotateGeneration)
        try {
          const existing = await this.vault!.rotateGeneration(
            generationKey,
            new TextEncoder().encode(token),
            RECEIPT_PREFIX,
            (previous) => {
              oldGeneration = generation(previous);
              receipt = {
                id,
                token,
                prefix: oldGeneration ? `${id}@${oldGeneration}:` : `${id}:`,
                requestedAt,
              };
              return { key: receiptKey(receipt), value: encode(receipt) };
            },
          );
          for (const [, value] of existing) {
            const held = decode(value);
            if (held) known.set(receiptKey(held), held);
          }
          vaultKept = true;
        } catch {
          // Fall through to the portable path; localStorage can retain the receipt while IndexedDB is refused.
        }
      if (!receipt)
        try {
          oldGeneration = generation(await this.vault!.get(generationKey));
          for (const [, value] of await this.vault!.entries(RECEIPT_PREFIX)) {
            const held = decode(value);
            if (held) known.set(receiptKey(held), held);
          }
        } catch {
          // A fallback receipt can still reconstruct the generation before cleanup.
        }
      receipt ??= {
        id,
        token,
        prefix: oldGeneration ? `${id}@${oldGeneration}:` : `${id}:`,
        requestedAt,
      };
      known.set(receiptKey(receipt), receipt);
      const next = [...known.values()];
      const fallbackKept = fallbackWrite(next);
      if (!vaultKept)
        try {
          const changes = [
            {
              kind: 'put' as const,
              key: generationKey,
              value: new TextEncoder().encode(token),
            },
            { kind: 'put' as const, key: receiptKey(receipt), value: encode(receipt) },
          ];
          if (this.vault!.commit) await this.vault!.commit(changes);
          else for (const change of changes) await this.vault!.put(change.key, change.value);
          vaultKept = true;
        } catch {
          // The fallback receipt reconstructs both values before cleanup on retry or reload.
        }
      this.pending = next.map((held) =>
        held === receipt && !fallbackKept && !vaultKept ? { ...held, failure: 'storage' } : held,
      );
      fallbackWrite(this.pending);
      this.#announce();
      return receipt;
    };
    const locks = globalThis.navigator?.locks;
    return locks
      ? locks.request(`den.library.${id}.retirement-prepare`, { mode: 'exclusive' }, prepare)
      : prepare();
  }

  start(receipt: LibraryRetirementReceipt | null): void {
    if (!receipt) return;
    setTimeout(() => void this.#attempt(receipt), 0);
  }

  retry(receipt?: LibraryRetirementReceipt): void {
    for (const held of receipt ? [receipt] : this.pending) void this.#attempt(held);
  }

  async refresh(retry = true): Promise<void> {
    const known = new SvelteSet(this.pending.map((receipt) => `${receipt.id}:${receipt.token}`));
    const found = new SvelteMap(fallbackRead().map((receipt) => [receiptKey(receipt), receipt]));
    if (this.vault)
      try {
        for (const [, value] of await this.vault.entries(RECEIPT_PREFIX)) {
          const receipt = decode(value);
          if (receipt) found.set(receiptKey(receipt), receipt);
        }
      } catch {
        // The fallback list remains visible and retryable while IndexedDB is refused.
      }
    this.pending = [...found.values()];
    fallbackWrite(this.pending);
    if (retry) this.retry();
    else
      for (const receipt of this.pending)
        if (!receipt.failure && !known.has(`${receipt.id}:${receipt.token}`))
          void this.#attempt(receipt);
  }

  async #attempt(receipt: LibraryRetirementReceipt): Promise<void> {
    const run = `${receipt.id}:${receipt.token}`;
    if (this.#running.has(run) || !this.pending.some((held) => same(held, receipt))) return;
    this.#running.add(run);
    let waiting = true;
    let waitFailure: Promise<void> | undefined;
    const timer = setTimeout(() => {
      if (waiting) waitFailure = this.#fail(receipt, 'wait');
    }, LOCK_WAIT_MS);
    try {
      const cleanup = async () => {
        waiting = false;
        await waitFailure;
        const owner = this.pending.find((held) => same(held, receipt));
        if (!owner || !this.vault) return;
        // The ordinary path is one verified transaction: the prepared receipt authorizes its exact-prefix delete.
        if (
          this.vault.retire &&
          (await this.vault.retire(owner.prefix, receiptKey(owner), encode(owner)))
        ) {
          await this.#settle(receipt);
          return;
        }
        // A localStorage-only recovery must restore a missing generation before a queued relink opens. Never replace
        // a present generation: a later unlink may already have advanced it and owns a different retired prefix.
        const generationKey = libraryGenerationKey(receipt.id);
        const currentGeneration = await this.vault.get(generationKey);
        const receiptChange = {
          kind: 'put' as const,
          key: receiptKey(owner),
          value: encode(owner),
        };
        if (!currentGeneration && this.vault.compareAndCommit) {
          const restored = await this.vault.compareAndCommit(generationKey, undefined, [
            {
              kind: 'put',
              key: generationKey,
              value: new TextEncoder().encode(receipt.token),
            },
            receiptChange,
          ]);
          if (!restored) await this.vault.put(receiptChange.key, receiptChange.value);
        } else if (!currentGeneration && this.vault.update) {
          await this.vault.update(
            generationKey,
            (current) => current ?? new TextEncoder().encode(receipt.token),
          );
          await this.vault.put(receiptChange.key, receiptChange.value);
        } else if (!currentGeneration && this.vault.commit) {
          await this.vault.commit([
            {
              kind: 'put',
              key: generationKey,
              value: new TextEncoder().encode(receipt.token),
            },
            receiptChange,
          ]);
        } else await this.vault.put(receiptChange.key, receiptChange.value);
        if (this.vault.retire) {
          if (!(await this.vault.retire(owner.prefix, receiptKey(owner), encode(owner)))) return;
        } else {
          await this.vault.remove(owner.prefix);
          await this.vault.delete(receiptKey(owner));
          if ((await this.vault.entries(owner.prefix)).length)
            throw new Error('Retired library cache remained after cleanup');
        }
        await this.#settle(receipt);
      };
      const locks = globalThis.navigator?.locks;
      if (locks)
        await locks.request(libraryRetirementLock(receipt.id), { mode: 'exclusive' }, cleanup);
      else await cleanup();
    } catch (error) {
      await this.#fail(receipt, 'storage');
      console.warn('den: the retired library cache could not be dropped', error);
    } finally {
      waiting = false;
      clearTimeout(timer);
      this.#running.delete(run);
    }
  }

  async #settle(receipt: LibraryRetirementReceipt): Promise<void> {
    if (!this.pending.some((held) => same(held, receipt))) return;
    this.pending = this.pending.filter((held) => !same(held, receipt));
    fallbackWrite(this.pending);
    this.#announce();
  }

  async #fail(
    receipt: LibraryRetirementReceipt,
    failure: NonNullable<LibraryRetirementReceipt['failure']>,
  ): Promise<void> {
    if (!this.pending.some((held) => same(held, receipt))) return;
    const failed = { ...receipt, failure };
    this.pending = this.pending.map((held) => (same(held, receipt) ? failed : held));
    fallbackWrite(this.pending);
    try {
      await this.vault?.put(receiptKey(failed), encode(failed));
    } catch {
      // The fallback receipt remains actionable.
    }
    this.#announce();
  }

  #announce(): void {
    this.#channel?.postMessage({ changed: true });
  }
}

export const libraryRetirements = new LibraryRetirements();
