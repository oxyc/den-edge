import { describe, expect, it } from 'vitest';
import {
  readCachedTranslationCatalog,
  readPresentationLanguageHint,
  rememberPresentationLanguage,
  rememberTranslationCatalog,
  translationCacheKeys,
} from './translationCache';

const memory = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    values,
  };
};

describe('translation cache', () => {
  it('remembers the effective language separately from synced preferences', () => {
    const kept = memory();
    expect(readPresentationLanguageHint(kept)).toBeUndefined();
    rememberPresentationLanguage('sv', kept);
    expect(readPresentationLanguageHint(kept)).toBe('sv');
  });

  it('round-trips a versioned non-English catalog for synchronous warm starts', () => {
    const kept = memory();
    const catalog = {
      revision: 'release-b',
      messages: { 'nav.home': 'Inicio' },
      phrases: { Play: 'Reproducir' },
    } as never;
    rememberTranslationCatalog('es', catalog, kept);
    expect(readCachedTranslationCatalog('es', kept)).toEqual(catalog);
    expect(kept.values.has(translationCacheKeys.catalog('es'))).toBe(true);
  });

  it('ignores malformed and English catalog entries', () => {
    const kept = memory();
    kept.setItem(translationCacheKeys.catalog('sv'), '{"revision":1}');
    expect(readCachedTranslationCatalog('sv', kept)).toBeUndefined();
    expect(readCachedTranslationCatalog('en', kept)).toBeUndefined();
  });
});
