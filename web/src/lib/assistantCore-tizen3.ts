const unsupported = () =>
  new Error('Assistant connections are managed from Den in a browser on Tizen 3.');

export function ensureAssistantPolicy(): Promise<void> {
  return Promise.reject(unsupported());
}

export function assistantAnswer(_request: string): string {
  throw unsupported();
}

export function assistantPolicy<T>(_request: Record<string, unknown>): T {
  throw unsupported();
}
