// Evaluated only in TV bundles, independently in the page and every Worker. Chrome 85/87 have the
// primitives Den needs, but not these later standard-library conveniences. Never JSON-clone library state.
import 'core-js/actual/array/at';
import 'core-js/actual/string/at';
import 'core-js/actual/object/has-own';
import 'core-js/actual/structured-clone';

if (!crypto.randomUUID) {
  Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    value: () => {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6]! & 15) | 64;
      bytes[8] = (bytes[8]! & 63) | 128;
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
  });
}

// The old AbortController ignores abort(reason). Preserve the reason for shared request cancellation.
if (!('reason' in AbortSignal.prototype)) {
  const reasons = new WeakMap<AbortSignal, unknown>();
  const abort = AbortController.prototype.abort;
  Object.defineProperty(AbortSignal.prototype, 'reason', {
    get() {
      return reasons.get(this);
    },
  });
  AbortController.prototype.abort = function (reason?: unknown) {
    if (!this.signal.aborted)
      reasons.set(this.signal, reason ?? new DOMException('Aborted', 'AbortError'));
    abort.call(this);
  };
}
if (!AbortSignal.prototype.throwIfAborted) {
  AbortSignal.prototype.throwIfAborted = function () {
    if (this.aborted) throw this.reason;
  };
}
if (!AbortSignal.timeout) {
  AbortSignal.timeout = (milliseconds: number) => {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
      throw new RangeError('Invalid timeout');
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds);
    return controller.signal;
  };
}
if (!AbortSignal.any) {
  AbortSignal.any = (signals: AbortSignal[]) => {
    const controller = new AbortController();
    const subscriptions = new Map<AbortSignal, () => void>();
    const finish = (signal: AbortSignal) => {
      controller.abort(signal.reason);
      for (const [source, listener] of subscriptions) source.removeEventListener('abort', listener);
      subscriptions.clear();
    };
    for (const signal of signals) {
      if (signal.aborted) {
        finish(signal);
        break;
      }
      if (subscriptions.has(signal)) continue;
      const listener = () => finish(signal);
      subscriptions.set(signal, listener);
      signal.addEventListener('abort', listener, { once: true });
    }
    return controller.signal;
  };
}
