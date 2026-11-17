/** A bounded delay that becomes idle immediately when any owning lifetime ends. */
export function abortableDelay(
  ms: number,
  ...signals: Array<AbortSignal | undefined>
): Promise<void> {
  if (signals.some((signal) => signal?.aborted)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      for (const signal of signals) signal?.removeEventListener('abort', done);
      resolve();
    }
    for (const signal of signals) signal?.addEventListener('abort', done, { once: true });
  });
}
