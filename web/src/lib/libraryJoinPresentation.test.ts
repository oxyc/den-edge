import { expect, it, vi } from 'vitest';
import { LibraryJoinPresentationOwner } from './libraryJoinPresentation';

it('invalidates an older operation on retry, authority replacement, and teardown', () => {
  const owner = new LibraryJoinPresentationOwner();
  owner.replace({});
  const old = owner.begin();
  const aborted = vi.fn();
  old.signal.addEventListener('abort', aborted);

  const retry = owner.begin();
  expect(old.isCurrent()).toBe(false);
  expect(aborted).toHaveBeenCalledOnce();
  expect(retry.isCurrent()).toBe(true);

  owner.replace({});
  expect(retry.isCurrent()).toBe(false);
  const replacement = owner.begin();
  owner.invalidate();
  expect(replacement.isCurrent()).toBe(false);
});
