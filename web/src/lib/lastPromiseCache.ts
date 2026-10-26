/** A one-entry cache for concurrent reads of an immutable snapshot. Failures remain retryable. */
export function lastPromiseCache<K, V>() {
  let current: { key: K; promise: Promise<V> } | undefined;
  return {
    read(key: K, load: () => Promise<V>): Promise<V> {
      const cached = current;
      if (cached && Object.is(cached.key, key)) return cached.promise;
      const promise = load();
      current = { key, promise };
      void promise.catch(() => {
        if (current?.promise === promise) current = undefined;
      });
      return promise;
    },
    forget(key: K): void {
      if (Object.is(current?.key, key)) current = undefined;
    },
  };
}
