/** One Settings presentation's ownership of a potentially durable library join. */
export interface LibraryJoinPresentationLease {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

/**
 * Owns one pairing join or recovery adoption for one exact Settings authority. Starting another operation or replacing
 * that authority synchronously invalidates the earlier lease. The durable join implementation uses the same lease at
 * its last pre-commit boundary; callers use it for every later presentation mutation.
 */
export class LibraryJoinPresentationOwner {
  #authority: object | null = null;
  #generation = 0;
  #controller: AbortController | null = null;

  replace(authority: object): void {
    if (this.#authority === authority) return;
    this.invalidate();
    this.#authority = authority;
  }

  begin(): LibraryJoinPresentationLease {
    this.invalidate();
    const generation = this.#generation;
    const controller = new AbortController();
    this.#controller = controller;
    return {
      signal: controller.signal,
      isCurrent: () =>
        this.#generation === generation &&
        this.#controller === controller &&
        !controller.signal.aborted,
    };
  }

  invalidate(): void {
    this.#generation++;
    this.#controller?.abort();
    this.#controller = null;
  }
}
