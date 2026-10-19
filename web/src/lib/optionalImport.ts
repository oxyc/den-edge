// Optional enhancements can fail without invalidating the page's native controls. Keep error identity rather
// than matching filenames/messages: WebKit's module-load error can omit the failed URL entirely.
const failures = new WeakSet<object>();

export function noteOptionalImportFailure(error: unknown): void {
  if (error !== null && (typeof error === 'object' || typeof error === 'function'))
    failures.add(error);
}

export function isOptionalImportFailure(error: unknown): boolean {
  return (
    error !== null &&
    (typeof error === 'object' || typeof error === 'function') &&
    failures.has(error)
  );
}
