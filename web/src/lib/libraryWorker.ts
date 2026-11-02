// Cached-library opening and the policy fold are CPU-heavy on a large history. Keep them in one Worker so its den-core
// instance is reused.

import { applyLog } from './library';
import type { Row } from './wire';
import { initializeStartup } from '../vendor/den-core/startup.js';

type Request =
  | {
      id: number;
      op: 'open';
      key: CryptoKey;
      name: string;
      bytes: ArrayBuffer;
    }
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

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    let value: unknown;
    if (request.op === 'open') {
      value = { opened: await openValue(request.key, request.name, request.bytes) };
    } else {
      await initializeStartup();
      value = applyLog(request.library, request.rows);
    }
    self.postMessage({ id: request.id, value });
  } catch (error) {
    self.postMessage({ id: request.id, error: message(error) });
  }
};
