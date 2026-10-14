// Work a page asks of the library service on its own, with no one waiting on it (the household's default Kid), can
// meet the service between connections: not ready yet, reopening at another wire (read-only until then), or a client
// closed by a session that was replaced. Those pass; a refusal is an answer, and is never asked again.

import { LibraryServiceError } from './libraryServiceClient';

/**
 * A failure of the service's connection rather than an answer to the request. `read-only` is one too: a household
 * opened from this browser's copy at wire 4 is read-only until the supervisor reopens it at 5. A build that is really
 * too old stays read-only, and the attempts run out.
 */
export function transientServiceFailure(error: unknown): boolean {
  if (!(error instanceof LibraryServiceError)) return false;
  const { code, retryable } = error.failure;
  return (
    retryable ||
    code === 'not-ready' ||
    code === 'cancelled' ||
    code === 'unavailable' ||
    code === 'read-only'
  );
}

const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

/**
 * `work`, asked again after each transient service failure with a growing wait, while `live` says the page still wants
 * it. `work` takes the service afresh each time, since a replaced session closes the one it had. The last failure, or
 * the first that is not transient, is thrown.
 */
export async function untilServiceSettles<T>(
  work: () => Promise<T>,
  options: {
    live?: () => boolean;
    backoffMs?: readonly number[];
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const backoff = options.backoffMs ?? BACKOFF_MS;
  const wait = options.wait ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (
        !transientServiceFailure(error) ||
        attempt >= backoff.length ||
        !(options.live?.() ?? true)
      )
        throw error;
      await wait(backoff[attempt]!);
    }
  }
}
