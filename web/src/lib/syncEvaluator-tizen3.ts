import { evaluate } from '../vendor/den-core-tizen3/index.js';

/** Tizen 3's checked-in JavaScript fallback remains one policy module. */
export function evaluatePolicy(request: Record<string, unknown>): string {
  return evaluate(JSON.stringify(request));
}
