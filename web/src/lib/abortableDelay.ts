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

/** A request deadline that also respects its owning lifetime. */
export function withDeadline(ms: number, owner?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  return owner ? AbortSignal.any([owner, deadline]) : deadline;
}
