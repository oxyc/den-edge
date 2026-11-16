import { describe, expect, it } from 'vitest';
import { API_PATH } from './runtimeUrl';

describe('packaged TV device API paths', () => {
  it('routes only the exact failure-report endpoint', () => {
    expect(API_PATH.test('/diagnostics/failure')).toBe(true);
    expect(API_PATH.test('/diagnostics')).toBe(false);
    expect(API_PATH.test('/diagnostics/failure/extra')).toBe(false);
    expect(API_PATH.test('/diagnostics-private/failure')).toBe(false);
    expect(API_PATH.test('/external/diagnostics/failure')).toBe(false);
  });
});
