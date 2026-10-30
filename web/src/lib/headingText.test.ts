import { describe, expect, it } from 'vitest';
import { capitalizeHeading } from './headingText';

describe('translated section headings', () => {
  it('capitalizes the first locale-aware character without title-casing the rest', () => {
    expect(capitalizeHeading('atracones', 'es')).toBe('Atracones');
    expect(capitalizeHeading('novelas policíacas', 'es')).toBe('Novelas policíacas');
    expect(capitalizeHeading('acción', 'es')).toBe('Acción');
    expect(capitalizeHeading('äventyr och action', 'sv')).toBe('Äventyr och action');
    expect(capitalizeHeading('already Correct', 'en')).toBe('Already Correct');
  });

  it('leaves an empty heading empty', () => {
    expect(capitalizeHeading('', 'es')).toBe('');
  });
});
