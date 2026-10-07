// Cached-library opening and the first policy projection are CPU-heavy on a large history. Keep both in one Worker
// so its den-core instance is reused; only the already-decrypted result crosses back to the page, as it did before.

import { applyLog } from './library';
import { projectDocument } from './libraryV4';
import { compareStamps, isDocument, newestSummary, ZERO_STAMP, type Row, type Stamp } from './wire';
import { initialize } from '../vendor/den-core/index.js';

type Request =
  | { id: number; op: 'open'; key: CryptoKey; name: string; bytes: ArrayBuffer }
  | { id: number; op: 'project'; source: Row[]; now: number }
  | {
      id: number;
      op: 'apply';
      library: Parameters<typeof applyLog>[0];
      rows: Row[];
    };

const utf8 = new TextEncoder();

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function openValue(key: CryptoKey, name: string, buffer: ArrayBuffer): Promise<unknown> {
  const bytes = new Uint8Array(buffer);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: utf8.encode(name) },
    key,
    bytes.subarray(12),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as unknown;
}

async function project(source: Row[], now: number) {
  await initialize();
  const rows: Row[] = [];
  let stamp: Stamp = ZERO_STAMP;
  let reconsiderAt = Infinity;
  for (const row of source) {
    rows.push(...(isDocument(row) ? projectDocument(row) : [row]));
    const summary = newestSummary(row, now);
    if (compareStamps(summary.stamp, stamp) > 0) stamp = summary.stamp;
    reconsiderAt = Math.min(reconsiderAt, summary.reconsiderAt ?? Infinity);
  }
  return { rows, stamp, reconsiderAt };
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    let value: unknown;
    if (request.op === 'open') value = await openValue(request.key, request.name, request.bytes);
    else if (request.op === 'project') value = await project(request.source, request.now);
    else {
      await initialize();
      value = applyLog(request.library, request.rows);
    }
    self.postMessage({ id: request.id, value });
  } catch (error) {
    self.postMessage({ id: request.id, error: message(error) });
  }
};
