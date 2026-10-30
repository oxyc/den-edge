import { describe, expect, it } from 'vitest';
import { localizePosterCaption } from './localizedRuntimeCopy';

const spanish = (value: string) =>
  ({ Series: 'Serie', seasons: 'temporadas', episodes: 'episodios' })[value] ?? value;

describe('localized poster captions', () => {
  it('translates authored runtime units without changing years or providers', () => {
    expect(localizePosterCaption('2019 · 4 seasons', spanish)).toBe('2019 · 4 temporadas');
    expect(localizePosterCaption('Netflix · Series', spanish)).toBe('Netflix · Serie');
    expect(localizePosterCaption('12 episodes', spanish)).toBe('12 episodios');
  });

  it('leaves unknown runtime copy untouched', () => {
    expect(localizePosterCaption('S2 · E4', spanish)).toBe('S2 · E4');
    expect(localizePosterCaption(undefined, spanish)).toBeUndefined();
  });
});
