/** Compact deterministic id for build-authored copy. Collisions are rejected while catalogs are constructed. */
export function phraseId(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export const phraseKey = (value: string): string => phraseId(value).toString(36);

export type PhraseCatalog = Readonly<Record<string, string>>;

export function compilePhrases(source: Readonly<Record<string, string>>): PhraseCatalog {
  const compiled: Record<string, string> = Object.create(null) as Record<string, string>;
  const owners = new Map<number, string>();
  for (const [english, translation] of Object.entries(source)) {
    const id = phraseId(english);
    const owner = owners.get(id);
    if (owner && owner !== english)
      throw new Error(
        `Translation phrase id collision: ${JSON.stringify(owner)} and ${JSON.stringify(english)}`,
      );
    owners.set(id, english);
    compiled[id.toString(36)] = translation;
  }
  return compiled;
}
