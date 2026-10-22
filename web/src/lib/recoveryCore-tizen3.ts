const unsupported = () => new Error('Recovery codes are managed from Den in a browser on Tizen 3.');

export function ensureRecoveryPolicy(): Promise<void> {
  return Promise.reject(unsupported());
}

export function recoveryPolicy<T>(_request: Record<string, unknown>): T {
  throw unsupported();
}
