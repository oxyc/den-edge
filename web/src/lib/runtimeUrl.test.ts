import { describe, expect, it } from 'vitest';
import { isDeviceApiPath } from './runtimeUrl';

describe('packaged TV device API paths', () => {
  it('routes only the bounded diagnostics namespace', () => {
    expect(isDeviceApiPath('/diagnostics/failure')).toBe(true);
    expect(isDeviceApiPath('/diagnostics')).toBe(true);
    expect(isDeviceApiPath('/diagnostics-private/failure')).toBe(false);
    expect(isDeviceApiPath('/external/diagnostics/failure')).toBe(false);
  });
});
