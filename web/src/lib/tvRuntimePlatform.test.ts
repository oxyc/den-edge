import { describe, expect, it } from 'vitest';
import { tvRuntimePlatform } from './tvRuntimePlatform';

describe('tvRuntimePlatform', () => {
  it('recognizes the native Android TV shell around the hosted TV build', () => {
    expect(
      tvRuntimePlatform(
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 DenAndroidTV/0.271.97',
        'webos',
        true,
      ),
    ).toBe('android');
  });

  it('does not let a normal browser opt itself into TV behavior with its user agent', () => {
    expect(tvRuntimePlatform('DenAndroidTV/1.2.3', 'browser', false)).toBe('browser');
  });

  it('retains native LG and Samsung targets', () => {
    expect(tvRuntimePlatform('Mozilla/5.0 (Web0S)', 'webos', true)).toBe('webos');
    expect(tvRuntimePlatform('Mozilla/5.0 (SMART-TV; Tizen)', 'tizen', true)).toBe('tizen');
  });
});
