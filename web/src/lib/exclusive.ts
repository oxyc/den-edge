// Old embedded engines lack Web Locks. Their library service is still one long-lived realm, so retain at least the
// same-realm ordering invariant instead of allowing two Vault read/modify/write transactions to overwrite each other.
const fallbackTails = new Map<string, Promise<void>>();

/** `work` under the lock `name` across tabs where supported, and serially in this realm everywhere else. */
export function exclusive<T>(name: string, work: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (locks) return locks.request(name, work);
  const previous = fallbackTails.get(name) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => turn);
  fallbackTails.set(name, tail);
  return previous.then(work).finally(() => {
    release();
    if (fallbackTails.get(name) === tail) fallbackTails.delete(name);
  });
}
