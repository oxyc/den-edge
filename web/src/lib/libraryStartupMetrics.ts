/** Per-library-open evidence for the large-library budgets. Counts contain no title or library identity. */
export interface LibraryStartupMetrics {
  documentsDecrypted: number;
  documentsFolded: number;
  documentsHydrated: number;
  factsChanged: number;
  factTransactions: number;
  decryptMs: number;
  foldMs: number;
  cacheBytesRead: number;
  cacheBytesWritten: number;
  viewSource: 'none' | 'cache' | 'authoritative';
  /** Edits made on a log of their own documents (`LibraryLog.openNarrow`), not the whole library. */
  narrowEdits: number;
  promotion?: string;
  /** Why the kept finished views were discarded or written again, each reason once. */
  viewsRewritten?: string[];
}

declare global {
  // Read by the production-build budget harness in the owning Worker.
  var __denLibraryStartupMetrics: LibraryStartupMetrics | undefined;
}

const empty = (): LibraryStartupMetrics => ({
  documentsDecrypted: 0,
  documentsFolded: 0,
  documentsHydrated: 0,
  factsChanged: 0,
  factTransactions: 0,
  decryptMs: 0,
  foldMs: 0,
  cacheBytesRead: 0,
  cacheBytesWritten: 0,
  viewSource: 'none',
  narrowEdits: 0,
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

export function noteLibraryFactCommit(documents: number): void {
  const held = metrics();
  held.factsChanged += documents;
  held.factTransactions += 1;
}

export function noteLibraryHydrate(documents = 1): void {
  metrics().documentsHydrated += documents;
}

export function noteLibraryCacheIO(source: 'read' | 'write', bytes: number): void {
  const held = metrics();
  if (source === 'read') held.cacheBytesRead += bytes;
  else held.cacheBytesWritten += bytes;
}

export function noteNarrowEdit(): void {
  metrics().narrowEdits += 1;
}

export function noteFinishedViewCacheHit(): void {
  metrics().viewSource = 'cache';
}

export function noteFinishedViewsRewrite(reason: string): void {
  const held = (metrics().viewsRewritten ??= []);
  if (!held.includes(reason) && held.length < 8) held.push(reason.slice(0, 120));
}

export function noteFinishedViewPromotion(reason: string): void {
  metrics().promotion ??= reason.slice(0, 80);
}
