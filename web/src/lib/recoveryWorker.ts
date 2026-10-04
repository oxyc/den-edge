// Runs recovery_derive (den-spec wire/recovery-code.md §3) off the page's thread: one Argon2id at 64 MiB. The code's
// data characters come in, `{locator, wrapKey}` or `{error}` goes out; nothing here is kept or logged.

import { evaluate, initialize } from '../vendor/den-core/index.js';

/**
 * `memory` when the wasm memory could not grow to the 64 MiB Argon2id needs — a RangeError from `Memory.grow`, or the
 * allocator's abort, which surfaces as `unreachable` — which a phone low on memory can do. Inferred from those
 * engines' messages, not observed on a device yet.
 */
function failure(error: unknown): string {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return error instanceof RangeError || /memory|alloc|unreachable/i.test(text)
    ? 'memory'
    : 'failed';
}

self.onmessage = async (event: MessageEvent<string>) => {
  try {
    await initialize();
    const envelope = JSON.parse(
      evaluate(JSON.stringify({ op: 'recovery_derive', data: event.data })),
    ) as { ok?: { locator: string; wrapKey: string }; error?: string };
    self.postMessage(envelope.ok ?? { error: envelope.error ?? 'protocol_mismatch' });
  } catch (error) {
    self.postMessage({ error: failure(error) });
  }
};
