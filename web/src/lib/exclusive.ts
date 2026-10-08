/** `work` under the lock `name` in every tab of this browser; with no `navigator.locks`, just `work`. */
export function exclusive<T>(name: string, work: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  return locks ? locks.request(name, work) : work();
}
