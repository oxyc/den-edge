/** Per-library-open evidence for the large-library budgets. Counts contain no title or library identity. */
export interface LibraryStartupMetrics {
  documentsDecrypted: number;
  documentsFolded: number;
  decryptMs: number;
  foldMs: number;
  cacheBytesRead: number;
  cacheBytesWritten: number;
  viewSource: 'none' | 'cache' | 'authoritative';
  promotion?: string;
}

declare global {
  // Read by the production-build budget harness in the owning Worker.
  var __denLibraryStartupMetrics: LibraryStartupMetrics | undefined;
}

const empty = (): LibraryStartupMetrics => ({
  documentsDecrypted: 0,
  documentsFolded: 0,
  decryptMs: 0,
  foldMs: 0,
  cacheBytesRead: 0,
  cacheBytesWritten: 0,
  viewSource: 'none',
});

const metrics = () => (globalThis.__denLibraryStartupMetrics ??= empty());

export function resetLibraryStartupMetrics(): void {
  globalThis.__denLibraryStartupMetrics = empty();
}

export function noteLibraryDecrypt(documents: number, elapsedMs: number): void {
  const held = metrics();
  held.documentsDecrypted += documents;
  held.decryptMs += elapsedMs;
}

export function noteLibraryFold(documents: number, elapsedMs: number): void {
  const held = metrics();
  held.documentsFolded += documents;
  held.foldMs += elapsedMs;
  held.viewSource = 'authoritative';
}

export function noteLibraryCacheIO(source: 'read' | 'write', bytes: number): void {
  const held = metrics();
  if (source === 'read') held.cacheBytesRead += bytes;
  else held.cacheBytesWritten += bytes;
}

export function noteFinishedViewCacheHit(): void {
  metrics().viewSource = 'cache';
}

export function noteFinishedViewPromotion(reason: string): void {
  metrics().promotion ??= reason.slice(0, 80);
}
