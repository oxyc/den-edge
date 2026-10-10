import { expect, test } from 'vitest';
import { parsePhoneLink, phoneLink } from './phoneLink';

const CODE = 'ABCDEFGH2345';
const TICKET = 'a1b2c3d4.AAAAAAAAAAAAAAAAAAAAAA';

test('a link carries the pairing code and the ticket in its fragment, and no library key', () => {
  const link = phoneLink('https://den.example', { ticket: TICKET, code: CODE });
  const url = new URL(link);
  expect(url.pathname + url.search, 'nothing the server sees').toBe('/');
  expect(url.hash).toBe(`#phone=${TICKET}&code=${CODE}`);
  expect(link).not.toMatch(/[?&#]k=/);
  expect(parsePhoneLink(link)).toEqual({ ticket: TICKET, code: CODE });
  expect(parsePhoneLink(url.hash)).toEqual({ ticket: TICKET, code: CODE });
});

test('a link made after the grant ended carries only the pairing', () => {
  const link = phoneLink('https://den.example', { ticket: null, code: CODE });
  expect(link).not.toContain('phone=');
  expect(parsePhoneLink(link)).toEqual({ ticket: null, code: CODE });
});

test('what is not a whole link is not one', () => {
  const good = phoneLink('https://den.example', { ticket: TICKET, code: CODE });
  expect(parsePhoneLink('https://den.example/')).toBeNull();
  expect(parsePhoneLink(`#phone=${TICKET}`)).toBeNull();
  expect(parsePhoneLink(good.replace(CODE, 'ABCD'))).toBeNull();
  expect(parsePhoneLink(good.replace(CODE, 'ABCDEFGHI0O1'))).toBeNull();
  expect(parsePhoneLink(good.replace('a1b2c3d4.', 'zz.'))).toBeNull();
  expect(parsePhoneLink('#invite=a1b2c3d4.AAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
});
