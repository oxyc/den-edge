import { evaluate } from '../vendor/den-core/index.js';

/** The same Rust policy as Apple TV. A failure is never an empty journal or an acknowledgement. */
export function syncPolicy<T>(request: Record<string, unknown>): T {
  const envelope = JSON.parse(evaluate(JSON.stringify(request))) as Record<string, unknown>;
  if (envelope.version !== 1 || typeof envelope.error === 'string' || !Object.hasOwn(envelope, 'ok')) {
    throw new Error(`Sync policy rejected the action: ${typeof envelope.error === 'string' ? envelope.error : 'protocol_mismatch'}`);
  }
  return envelope.ok as T;
}
