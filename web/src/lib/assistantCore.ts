// den-core's assistant ops (den-spec wire/assistant-v1.md), a wasm module of their own: they carry the assistant
// crypto, which no other op needs, so it is fetched only by a library that has an assistant connected, or is
// connecting one — never on a first visit, and never for a library without one.
import { policyAnswer } from './syncCore';

let evaluate: ((request: string) => string) | undefined;
let pending: Promise<void> | undefined;

/** Load the module once; concurrent callers share the load, and a failed one may be tried again. */
export function ensureAssistantPolicy(): Promise<void> {
  if (evaluate) return Promise.resolve();
  pending ??= import('../vendor/den-core/assistant.js')
    .then(async (module) => {
      await module.initializeAssistant();
      evaluate = module.evaluateAssistant;
    })
    .catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
  return pending;
}

/** An `assistant_*` op, once `ensureAssistantPolicy` has settled. A failure is never an empty answer. */
export function assistantPolicy<T>(request: Record<string, unknown>): T {
  if (!evaluate) throw new Error('the assistant policy is not loaded');
  return policyAnswer<T>(evaluate(JSON.stringify(request)));
}
