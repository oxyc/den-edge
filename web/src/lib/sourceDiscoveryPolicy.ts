import { ensureDeferredSyncPolicy } from './syncLoader';
import { syncPolicy } from './syncCore';
import type { SourceWaitAnswer, SourceWaitRequest } from './libraryServiceProtocol';

/** Thin Edge binding to den-core's authoritative wait operation; it deliberately contains no timing rules. */
export async function sourceWait(request: SourceWaitRequest): Promise<SourceWaitAnswer> {
  await ensureDeferredSyncPolicy();
  const answer = syncPolicy<{
    phase: SourceWaitAnswer['phase'];
    next_ms: number | null;
    retry_in_ms: number | null;
  }>({
    op: 'source_wait',
    elapsed_ms: request.elapsedMs,
    attempt: request.attempt,
    ...(request.onlineRestored ? { online_restored: true } : {}),
    ...(request.retryAfterMs !== undefined ? { retry_after_ms: request.retryAfterMs } : {}),
    jitter: request.jitter ?? Math.random(),
  });
  return { phase: answer.phase, nextMs: answer.next_ms, retryInMs: answer.retry_in_ms };
}
