import { ensureDeferredSyncPolicy } from './syncLoader';
import { syncPolicy } from './syncCore';

export interface SourceWaitAnswer {
  phase: 'loading' | 'slow' | 'deadline';
  next_ms: number | null;
  retry_in_ms: number | null;
}

export interface SourceWaitRequest {
  elapsed_ms: number;
  attempt: number;
  online_restored?: boolean;
  retry_after_ms?: number;
  jitter?: number;
}

/** Thin Edge binding to den-core's authoritative wait operation; it deliberately contains no timing rules. */
export async function sourceWait(request: SourceWaitRequest): Promise<SourceWaitAnswer> {
  await ensureDeferredSyncPolicy();
  return syncPolicy<SourceWaitAnswer>({
    op: 'source_wait',
    ...request,
    jitter: request.jitter ?? Math.random(),
  });
}
