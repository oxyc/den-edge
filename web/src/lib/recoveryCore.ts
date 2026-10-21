// Recovery code §3's Argon2id KDF lives outside the ordinary policy module. Nothing downloads or instantiates this
// 64 MiB-memory capability until a person actually makes or redeems a recovery code.
import { policyAnswer } from './syncCore';

let evaluate: ((request: string) => string) | undefined;
let pending: Promise<void> | undefined;

/** Load the recovery KDF once; concurrent callers share the load, and a failed one may be tried again. */
export function ensureRecoveryPolicy(): Promise<void> {
  if (evaluate) return Promise.resolve();
  pending ??= import('../vendor/den-core/recovery.js')
    .then(async (module) => {
      await module.initializeRecovery();
      evaluate = module.evaluateRecovery;
    })
    .catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
  return pending;
}

/** A recovery KDF answer, once `ensureRecoveryPolicy` has settled. */
export function recoveryPolicy<T>(request: Record<string, unknown>): T {
  if (!evaluate) throw new Error('the recovery policy is not loaded');
  return policyAnswer<T>(evaluate(JSON.stringify(request)));
}
