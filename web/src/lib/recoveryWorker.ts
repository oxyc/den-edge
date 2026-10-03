// Runs recovery_derive (den-spec wire/recovery-code.md §3) off the page's thread: one Argon2id at 64 MiB. The code's
// data characters come in, `{locator, wrapKey}` or `{error}` goes out; nothing here is kept or logged.

import { evaluate, initialize } from '../vendor/den-core/index.js';

self.onmessage = async (event: MessageEvent<string>) => {
  try {
    await initialize();
    const envelope = JSON.parse(
      evaluate(JSON.stringify({ op: 'recovery_derive', data: event.data })),
    ) as { ok?: { locator: string; wrapKey: string }; error?: string };
    self.postMessage(envelope.ok ?? { error: envelope.error ?? 'protocol_mismatch' });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'failed' });
  }
};
