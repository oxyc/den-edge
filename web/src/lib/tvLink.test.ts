import { describe, expect, it } from 'vitest';
import { parseTVLink, tvLink } from './tvLink';

describe('TV pairing camera links', () => {
  it('uses a normal HTTPS URL and keeps the pairing code in its fragment', () => {
    const address = tvLink('https://d.oxy.fi', 'ABCD-EFGH-JKLM');
    expect(address).toBe('https://d.oxy.fi/settings#tv=ABCDEFGHJKLM');
    expect(parseTVLink(address)).toBe('ABCDEFGHJKLM');
  });

  it('refuses malformed and unrelated links', () => {
    expect(parseTVLink('https://d.oxy.fi/settings#other=ABCDEFGHJKLM')).toBeNull();
    expect(parseTVLink('https://d.oxy.fi/settings#tv=short')).toBeNull();
    expect(() => tvLink('https://d.oxy.fi', 'short')).toThrow('invalid TV pairing code');
  });
});
