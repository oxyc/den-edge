import { describe, expect, it, vi } from 'vitest';
import { interfaceLocale, tmdbLanguage, type InterfaceLanguage } from './interfaceLanguage';
import { LocalizedContent } from './localizedContent';
import type { ContentServiceClientPort } from './contentServiceClient';

describe('interface language', () => {
  it('keeps English on the established TMDB cache namespace', () => {
    expect(interfaceLocale('en')).toBe('en-US');
    expect(tmdbLanguage('en')).toBeUndefined();
    expect(tmdbLanguage('es')).toBe('es-ES');
    expect(tmdbLanguage('sv')).toBe('sv-SE');
  });

  it('adds the current profile language at the content-worker boundary', async () => {
    let language: InterfaceLanguage = 'es';
    const query = vi.fn(async (request) => ({ kind: request.kind }));
    const inner = {
      query,
      onStatus: () => () => {},
    } as unknown as ContentServiceClientPort;
    const content = new LocalizedContent(inner, () => language);

    await content.query({ kind: 'service.regions' });
    language = 'sv';
    await content.query({ kind: 'service.regions' });

    expect(query.mock.calls.map(([request]) => request)).toEqual([
      { kind: 'service.regions', interfaceLanguage: 'es' },
      { kind: 'service.regions', interfaceLanguage: 'sv' },
    ]);
  });
});
