import { describe, expect, it } from 'vitest';
import { localizePosterCaption } from './localizedRuntimeCopy';
import { sourcePhrases as esPhrases } from './messages/phrases/es';
import { sourcePhrases as svPhrases } from './messages/phrases/sv';

const spanish = (value: string) =>
  ({ Series: 'Serie', seasons: 'temporadas', episodes: 'episodios' })[value] ?? value;

describe('localized poster captions', () => {
  it('translates authored runtime units without changing years or providers', () => {
    expect(localizePosterCaption('2019 · 4 seasons', spanish)).toBe('2019 · 4 temporadas');
    expect(localizePosterCaption('Netflix · Series', spanish)).toBe('Netflix · Serie');
    expect(localizePosterCaption('12 episodes', spanish)).toBe('12 episodios');
  });

  it('translates the remake note through the shipped catalogs and keeps franchise labels verbatim', () => {
    const caption = (catalog: Record<string, string>, value: string) =>
      localizePosterCaption(value, (part) => catalog[part] ?? part);
    expect(caption(esPhrases, '1998 · Remake')).toBe('1998 · Nueva versión');
    expect(caption(svPhrases, '1998 · Remake')).toBe('1998 · Nyinspelning');
    expect(caption(svPhrases, '1994 · Wallander (Sweden)')).toBe('1994 · Wallander (Sweden)');
    expect(caption(esPhrases, '1998')).toBe('1998');
  });

  it('leaves unknown runtime copy untouched', () => {
    expect(localizePosterCaption('S2 · E4', spanish)).toBe('S2 · E4');
    expect(localizePosterCaption(undefined, spanish)).toBeUndefined();
  });
});
