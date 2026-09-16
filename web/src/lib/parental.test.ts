import { describe, expect, it } from 'vitest';
import { isBlocked, level, levelOf, strictest } from './parental';

describe('parental ratings', () => {
  it('reads a rating in its own country’s system, case and space insensitively', () => {
    expect(level('PG-13', 'US')).toBe(0);
    expect(level('r', 'us')).toBe(1);
    expect(level(' NC-17 ', 'US')).toBe(2);
    expect(level('Btl', 'SE')).toBe(0);
    expect(level('K-18', 'FI')).toBe(1);
  });

  it('knows nothing about an unmapped rating or an unmapped country', () => {
    expect(level('12', 'JP')).toBeUndefined();
    expect(level('UNRATED', 'US')).toBeUndefined();
    expect(level('', 'US')).toBeUndefined();
    expect(level(undefined, 'US')).toBeUndefined();
  });

  it('takes the stricter of US and the viewer’s region', () => {
    // Finland passes it for 12s, the US calls it R: the stricter wins.
    expect(levelOf({ US: 'R', FI: 'K-12' }, 'FI')).toBe(1);
    expect(levelOf({ US: 'PG', FI: 'K-18' }, 'FI')).toBe(1);
  });

  it('still reads US when the region has no entry, and vice versa', () => {
    expect(levelOf({ US: 'R' }, 'FI')).toBe(1);
    expect(levelOf({ FI: 'K-18' }, 'FI')).toBe(1);
    expect(levelOf({ JP: '18' }, 'JP')).toBeUndefined();
  });

  it('blocks only above the ceiling', () => {
    expect(isBlocked({ US: 'R' }, 'US', 'pg13')).toBe(true);
    expect(isBlocked({ US: 'R' }, 'US', 'r')).toBe(false);
    expect(isBlocked({ US: 'NC-17' }, 'US', 'r')).toBe(true);
    expect(isBlocked({ US: 'PG-13' }, 'US', 'pg13')).toBe(false);
  });

  it('blocks nothing without a ceiling, and nothing it cannot read', () => {
    expect(isBlocked({ US: 'NC-17' }, 'US', undefined)).toBe(false);
    // An unmapped rating is not evidence: hiding every unrated title would empty the page.
    expect(isBlocked({ US: 'UNRATED' }, 'US', 'pg13')).toBe(false);
    expect(isBlocked({}, 'US', 'pg13')).toBe(false);
  });

  it('picks the strictest of a country’s releases, and keeps the first when none maps', () => {
    expect(strictest(['PG-13', 'R'], 'US')).toBe('R');
    // An unrated release listed first cannot hide a rated one.
    expect(strictest(['', 'NR', 'R'], 'US')).toBe('R');
    expect(strictest(['NR', 'Unrated'], 'US')).toBe('NR');
    expect(strictest([], 'US')).toBeUndefined();
  });
});
