import { expect, test } from 'vitest';
import { parsePhoneLink, phoneLink } from './phoneLink';

const KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i * 7 + 1)));
const TICKET = 'a1b2c3d4.AAAAAAAAAAAAAAAAAAAAAA';

test('a link carries the ticket and the library key in its fragment, and reads back', () => {
  const link = phoneLink('https://den.example', { ticket: TICKET, libraryKey: KEY });
  const url = new URL(link);
  expect(url.pathname + url.search, 'nothing the server sees').toBe('/');
  expect(url.hash).toMatch(/^#phone=a1b2c3d4\.AAAAAAAAAAAAAAAAAAAAAA&k=[A-Za-z0-9_-]{43}$/);
  expect(parsePhoneLink(link)).toEqual({ ticket: TICKET, libraryKey: KEY });
  expect(parsePhoneLink(url.hash)).toEqual({ ticket: TICKET, libraryKey: KEY });
});

test('a link made after the grant ended carries only the library', () => {
  const link = phoneLink('https://den.example', { ticket: null, libraryKey: KEY });
  expect(link).not.toContain('phone=');
  expect(parsePhoneLink(link)).toEqual({ ticket: null, libraryKey: KEY });
});

test('what is not a whole link is not one', () => {
  const good = phoneLink('https://den.example', { ticket: TICKET, libraryKey: KEY });
  expect(parsePhoneLink('https://den.example/')).toBeNull();
  expect(parsePhoneLink('#phone=' + TICKET)).toBeNull();
  expect(parsePhoneLink(good.replace(/k=.{3}/, 'k=ab'))).toBeNull();
  expect(parsePhoneLink(good.replace('a1b2c3d4.', 'zz.'))).toBeNull();
  expect(parsePhoneLink('#invite=a1b2c3d4.AAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
});
