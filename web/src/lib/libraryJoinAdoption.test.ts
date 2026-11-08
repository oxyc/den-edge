import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { JoinLibrary, JoinLink } from './browserHousehold';
import { adoptRecoveredLibrary } from './libraryJoinAdoption';
import { LibraryJoinPresentationOwner } from './libraryJoinPresentation';
import { Links } from './links.svelte';

const gate = () => {
  let release = () => {};
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
};

beforeEach(() => {
  const kept = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  });
  vi.stubGlobal('window', new EventTarget());
});

afterEach(() => vi.unstubAllGlobals());

it('does not publish recovery credentials when its presentation is replaced before commit', async () => {
  const store = new Links();
  const owner = new LibraryJoinPresentationOwner();
  owner.replace({});
  const held = gate();
  const join: JoinLibrary = async () => {
    await held.promise;
    return 'failed';
  };
  const opened = vi.fn();
  const adoption = adoptRecoveredLibrary('recovered', owner.begin(), join, store, opened);

  owner.replace({});
  held.release();
  await expect(adoption).resolves.toBe(false);
  expect(store.list).toEqual([]);
  expect(opened).not.toHaveBeenCalled();
});

it('reverses post-commit recovery completions without replacing or selecting newer credentials', async () => {
  const store = new Links();
  const owner = new LibraryJoinPresentationOwner();
  owner.replace({});
  const calls: Array<{ link: JoinLink; held: ReturnType<typeof gate> }> = [];
  const join: JoinLibrary = async (key, options) => {
    const call = { link: options!.link!, held: gate() };
    calls.push(call);
    await call.held.promise;
    // RoutedLibrary's exact post-commit reconciliation runs even though the initiating presentation is now stale.
    store.reconcileCommitted(call.link, key);
    return 'joined';
  };
  const opened = vi.fn();
  const old = adoptRecoveredLibrary('old-library', owner.begin(), join, store, opened);
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  const replacementAuthority = {};
  owner.replace(replacementAuthority);
  const newer = adoptRecoveredLibrary('new-library', owner.begin(), join, store, opened);
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  const oldCall = calls[0]!;
  const newerCall = calls[1]!;

  store.add(newerCall.link.inboxKey, {
    name: 'Replacement',
    libraryKey: 'replacement-library',
    linkKey: 'replacement-key',
  });
  store.makeCurrent(newerCall.link.inboxKey);
  newerCall.held.release();
  await expect(newer).resolves.toBe(false);
  oldCall.held.release();
  await expect(old).resolves.toBe(false);

  expect(store.current).toMatchObject({
    name: 'Replacement',
    libraryKey: 'replacement-library',
    linkKey: 'replacement-key',
  });
  expect(store.list).toHaveLength(2);
  expect(opened).not.toHaveBeenCalled();
});
