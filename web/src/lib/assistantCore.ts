// den-core's assistant ops (den-spec wire/assistant-v1.md), a wasm module of their own: they carry the assistant
// crypto, which no other op needs, so it is fetched only by a library that has an assistant connected, or is
// connecting one — never on a first visit, and never for a library without one.
import { policyAnswer } from './syncCore';

const WASM = new URL('../vendor/den-core/generated/den_core_assistant_bg.wasm', import.meta.url);

let evaluate: ((request: string) => string) | undefined;
let pending: Promise<void> | undefined;
/** The module as compiled here, handed whole to the projection Worker (`assistantProjection.ts`); null without one. */
let compiled: WebAssembly.Module | null = null;

/** Compiled once: this Worker instantiates it, and each projection Worker is handed it rather than compiling again. */
async function compile(): Promise<WebAssembly.Module | null> {
  try {
    return await WebAssembly.compileStreaming(fetch(WASM, { signal: AbortSignal.timeout(15_000) }));
  } catch (error) {
    // The module then loads itself, as before, and a projection is built in this thread.
    console.warn('den: the assistant module could not be compiled to share', error);
    return null;
  }
}

/** Load the module once; concurrent callers share the load, and a failed one may be tried again. */
export function ensureAssistantPolicy(): Promise<void> {
  if (evaluate) return Promise.resolve();
  pending ??= Promise.all([import('../vendor/den-core/assistant.js'), compile()])
    .then(async ([module, made]) => {
      await module.initializeAssistant(made ?? undefined);
      compiled = made;
      evaluate = module.evaluateAssistant;
    })
    .catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
  return pending;
}

/** The compiled module, once `ensureAssistantPolicy` has settled; null when it loaded itself. */
export const assistantModule = (): WebAssembly.Module | null => compiled;

/** An `assistant_*` op's answer as den-core writes it, once `ensureAssistantPolicy` has settled. */
export function assistantAnswer(request: string): string {
  if (!evaluate) throw new Error('the assistant policy is not loaded');
  return evaluate(request);
}

/** An `assistant_*` op, once `ensureAssistantPolicy` has settled. A failure is never an empty answer. */
export function assistantPolicy<T>(request: Record<string, unknown>): T {
  return policyAnswer<T>(assistantAnswer(JSON.stringify(request)));
}
