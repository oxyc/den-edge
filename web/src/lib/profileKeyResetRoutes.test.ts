import { describe, expect, it } from 'vitest';
import { profileResetHeadersAllowed, profileResetRoute } from './profileKeyResetRoutes';

const LIB = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const ATTEMPT = '0123456789abcdef0123456789abcdef';

describe('profile key reset routes', () => {
  it.each([
    ['GET', `/lib/${LIB}/exclusive-operation/source`, { kind: 'source' }],
    ['POST', `/lib/${LIB}/exclusive-operation`, { kind: 'acquire' }],
    ['GET', `/lib/${LIB}/exclusive-operation/${ATTEMPT}`, { kind: 'lookup', attempt: ATTEMPT }],
    ['DELETE', `/lib/${LIB}/exclusive-operation/${ATTEMPT}`, { kind: 'abort', attempt: ATTEMPT }],
    [
      'POST',
      `/lib/${LIB}/exclusive-operation/${ATTEMPT}/successor`,
      { kind: 'successor', attempt: ATTEMPT },
    ],
    ['DELETE', `/lib/${LIB}`, { kind: 'retire' }],
  ] as const)('classifies %s %s', (method, path, expected) => {
    expect(profileResetRoute(LIB, method, path)).toEqual(expected);
  });

  it.each([
    ['GET', `/lib/${LIB}`],
    ['POST', `/lib/${LIB}`],
    ['PUT', `/lib/${LIB}/member`],
    ['POST', `/lib/${LIB}/batch`],
    ['GET', `/lib/${LIB}/changes?since=0`],
    ['POST', `/lib/${LIB}/exclusive-operation/source`],
    ['GET', `/lib/${LIB}/exclusive-operation/${ATTEMPT}/successor`],
    ['DELETE', `/lib/${LIB}/exclusive-operation/${ATTEMPT}/successor`],
    ['POST', `/lib/${LIB}/exclusive-operation/${ATTEMPT}`],
    ['GET', `/lib/${LIB}/exclusive-operation/not-an-attempt`],
    ['GET', `/lib/${LIB}/exclusive-operation/${ATTEMPT.toUpperCase()}`],
    ['GET', `/lib/${LIB}/exclusive-operation/${ATTEMPT}?x=1`],
    ['GET', `/lib/${LIB}/exclusive-operation/../source`],
    ['DELETE', `/lib/${LIB}/`],
    ['GET', `/lib/b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2/exclusive-operation/source`],
    ['GET', `https://evil.example/lib/${LIB}/exclusive-operation/source`],
  ] as const)('never classifies %s %s', (method, path) => {
    expect(profileResetRoute(LIB, method as 'GET', path)).toBeNull();
  });

  it('refuses a library id that is not canonical', () => {
    expect(profileResetRoute('short', 'GET', '/lib/short/exclusive-operation/source')).toBeNull();
  });

  it('allows only the headers each route needs', () => {
    const acquire = profileResetRoute(LIB, 'POST', `/lib/${LIB}/exclusive-operation`)!;
    const retire = profileResetRoute(LIB, 'DELETE', `/lib/${LIB}`)!;
    const source = profileResetRoute(LIB, 'GET', `/lib/${LIB}/exclusive-operation/source`)!;
    expect(profileResetHeadersAllowed(acquire, { 'x-den-successor-token': 't' })).toBe(true);
    expect(profileResetHeadersAllowed(acquire, { 'x-den-successor': 't' })).toBe(false);
    expect(
      profileResetHeadersAllowed(retire, {
        'x-den-exclusive-attempt': ATTEMPT,
        'x-den-successor': LIB,
      }),
    ).toBe(true);
    expect(profileResetHeadersAllowed(retire, { 'x-den-successor-token': 't' })).toBe(false);
    expect(profileResetHeadersAllowed(source, {})).toBe(true);
    expect(profileResetHeadersAllowed(source, { 'x-den-library-token': 'stolen' })).toBe(false);
    expect(profileResetHeadersAllowed(source, { 'x-den-wire': '4' })).toBe(false);
  });
});
