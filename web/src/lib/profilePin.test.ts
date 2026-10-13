import { describe, expect, it } from 'vitest';
import { profilePinInput } from './profilePin';

describe('profile PIN input', () => {
  it('submits exactly four numeric digits', () => {
    expect(profilePinInput('12')).toEqual({ value: '12', complete: false });
    expect(profilePinInput('12a34')).toEqual({ value: '1234', complete: true });
    expect(profilePinInput('12345')).toEqual({ value: '1234', complete: true });
  });
});
