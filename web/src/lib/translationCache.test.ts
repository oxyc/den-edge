import { describe, expect, it } from 'vitest';
import {
  readCachedTranslationCatalog,
  readFreshPresentationLanguageHint,
  readPresentationLanguageHint,
  rememberFreshPresentationLanguage,
  rememberPresentationLanguage,
  rememberTranslationCatalog,
  translationCacheKeys,
  translationCacheSchema,
} from './translationCache';
import { messages as spanishMessages } from './messages/es';
import { phraseKey } from './messages/phraseCatalog';

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

  it('gives a completed selection only a bounded revalidation grace period', () => {
    const kept = memory();
    rememberFreshPresentationLanguage('es', kept);
    const selectedAt = Number(
      kept.values.get('den.interfaceLanguage.presentation.v2.default.written-at'),
    );
    expect(readFreshPresentationLanguageHint(kept, selectedAt)).toBe('es');
    expect(readFreshPresentationLanguageHint(kept, selectedAt + 5 * 60_000 + 1)).toBeUndefined();
  });

  it('keeps first-frame language hints separate for profiles sharing one browser', () => {
    const kept = memory();
    const first = '1'.repeat(32);
    const second = '2'.repeat(32);
    kept.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: first }),
    );
    rememberPresentationLanguage('es', kept);
    kept.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: second }),
    );
    expect(readPresentationLanguageHint(kept)).toBeUndefined();
    rememberPresentationLanguage('sv', kept);
    kept.setItem(
      'den.profile.active.v1',
      JSON.stringify({ version: 1, mode: 'persistent', profileId: first }),
    );
    expect(readPresentationLanguageHint(kept)).toBe('es');
  });

  it('round-trips a versioned non-English catalog for synchronous warm starts', () => {
    const kept = memory();
    const catalog = {
      schema: translationCacheSchema,
      language: 'es' as const,
      revision: '0123456789abcdef',
      messages: spanishMessages,
      phrases: { [phraseKey('Play')]: 'Reproducir' },
      parameters: {},
    };
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
