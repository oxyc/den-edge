import { describe, expect, it } from 'vitest';
import { isDeviceApiPath } from './runtimeUrl';

describe('packaged TV device API paths', () => {
  it('routes only the exact failure-report endpoint', () => {
    expect(isDeviceApiPath('/diagnostics/failure')).toBe(true);
    expect(isDeviceApiPath('/diagnostics')).toBe(false);
    expect(isDeviceApiPath('/diagnostics/failure/extra')).toBe(false);
    expect(isDeviceApiPath('/diagnostics-private/failure')).toBe(false);
    expect(isDeviceApiPath('/external/diagnostics/failure')).toBe(false);
  });
});
