import { evaluate } from '../vendor/den-core/index.js';

// At 120 Hz a frame is 8.3 ms; leaving roughly half for input, rendering and other app work proved materially
// smoother than an 8 ms policy slice without increasing total projection time in the real-WASM fixture.
const POLICY_SLICE_MS = 4;

export interface PolicySliceOptions {
  /** Tests and benchmarks replace these; production uses the monotonic browser clock and a real task boundary. */
  now?: () => number;
  yieldTask?: () => Promise<void>;
  budgetMs?: number;
  /** False means the staging owner was replaced; stop before doing another unit of policy work. */
  shouldContinue?: () => boolean;
}

/** Let input, paint and timers run before continuing a large, off-screen policy projection. */
export async function yieldTask(): Promise<void> {
  const scheduler = (
    globalThis as typeof globalThis & {
      scheduler?: { yield?: () => Promise<void> };
    }
  ).scheduler;
  if (scheduler?.yield) {
    await scheduler.yield();
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Apply synchronous den-core work in time-bounded tasks. `work` writes only caller-owned staging state; callers
 * publish it after this promise resolves, so a yield can never expose a half-projected library.
 */
export async function inPolicySlices<T>(
  values: Iterable<T>,
  work: (value: T) => void,
  options: PolicySliceOptions = {},
): Promise<boolean> {
  const now = options.now ?? (() => performance.now());
  const pause = options.yieldTask ?? yieldTask;
  const budget = options.budgetMs ?? POLICY_SLICE_MS;
  let started = now();
  for (const value of values) {
    if (options.shouldContinue && !options.shouldContinue()) return false;
    work(value);
    if (now() - started < budget) continue;
    await pause();
    started = now();
  }
  return options.shouldContinue?.() ?? true;
}

/** The same Rust policy as Apple TV. A failure is never an empty journal or an acknowledgement. */
export function syncPolicy<T>(request: Record<string, unknown>): T {
  const envelope = JSON.parse(evaluate(JSON.stringify(request))) as Record<string, unknown>;
  if (
    envelope.version !== 1 ||
    typeof envelope.error === 'string' ||
    !Object.hasOwn(envelope, 'ok')
  ) {
    throw new Error(
      `Sync policy rejected the action: ${typeof envelope.error === 'string' ? envelope.error : 'protocol_mismatch'}`,
    );
  }
  return envelope.ok as T;
}
