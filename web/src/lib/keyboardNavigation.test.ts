import { describe, expect, it } from 'vitest';
import {
  isOptionalImportFailure,
  markOptionalImportFailure,
  optionalImport,
} from './keyboardNavigation';

describe('optional navigation imports', () => {
  it('marks the exact rejected import before deferred preload recovery decides to reload', () => {
    const failure = new TypeError('stale optional chunk');
    expect(isOptionalImportFailure(failure)).toBe(false);
    markOptionalImportFailure(failure);
    expect(isOptionalImportFailure(failure)).toBe(true);
    expect(isOptionalImportFailure(new TypeError('stale optional chunk'))).toBe(false);
  });

  it('does not treat primitive failures as optional identities', () => {
    markOptionalImportFailure('stale optional chunk');
    expect(isOptionalImportFailure('stale optional chunk')).toBe(false);
  });

  it('marks every failed request when an enhancement loads several chunks in parallel', async () => {
    const failures = [
      new TypeError('stale services chunk'),
      new TypeError('stale directory chunk'),
    ];
    await Promise.allSettled(failures.map((failure) => optionalImport(Promise.reject(failure))));
    expect(failures.map(isOptionalImportFailure)).toEqual([true, true]);
  });
});
