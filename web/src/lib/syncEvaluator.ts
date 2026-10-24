import { evaluateStartup } from '../vendor/den-core/startup.js';
import { evaluateDeferred } from '../vendor/den-core/deferred.js';
import { isStartupOperation } from '../vendor/den-core/lifecycle.js';

/** Route one synchronous request after its lifecycle module has been initialized. */
export function evaluatePolicy(request: Record<string, unknown>): string {
  const input = JSON.stringify(request);
  return isStartupOperation(String(request.op)) ? evaluateStartup(input) : evaluateDeferred(input);
}
