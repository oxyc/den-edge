import { afterEach, describe, expect, it, vi } from 'vitest';
import { HouseholdSession } from './householdSession.svelte';
import type { LibraryModel } from './libraryModel.svelte';
import { persistentProfileIdentity } from './profileIdentity';
import { activeProfileSession, legacyProfileSession } from './profileSession.svelte';

const KID_ID = '0123456789abcdef0123456789abcdef';

afterEach(() => vi.useRealTimers());

describe('ProfileSession presentation state', () => {
  const content = () => ({ query: vi.fn(), onStatus: vi.fn(() => () => {}) });

  it('indexes title metadata, absences and shapes without owning library rows', () => {
    const session = legacyProfileSession(null, false, null, content());
    const title = { type: 'tv' as const, id: 1, title: 'One' };
    const gone = { type: 'movie' as const, id: 2 };
    session.publishLibraryMetadata(
      [title, { ...title, title: 'Later' }],
      [['tv:1', { counts: new Map([[1, 8]]), lastAired: { season: 1, episode: 4 } }]],
      [gone, title],
    );

    expect([...session.displayTitles().values()]).toEqual([title]);
    expect(session.displayTitle(title)).toBe(title);
    expect(session.displayMissing(gone)).toBe(true);
    expect(session.displayMissing(title)).toBe(false);
    expect(session.shapes.get('tv:1')?.counts.get(1)).toBe(8);
  });

  it('forwards each foreground and close transition once', () => {
    const foregroundReady = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    const closeWorkerServices = vi.fn();
    const contentPort = {
      query: vi.fn(),
      onStatus: vi.fn(() => () => {}),
    };
    const model = { foregroundReady, close } as unknown as LibraryModel;
    const session = legacyProfileSession(
      'same-library-key',
      false,
      model,
      contentPort,
      closeWorkerServices,
    );

    session.foregroundReady();
    session.foregroundReady();
    session.close();
    session.close();

    expect(foregroundReady).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(session.identity).toMatchObject({
      kind: 'owner',
      libraryKey: 'same-library-key',
      retainedScope: 'same-library-key',
    });
    expect(session.household.model).toBe(model);
    expect(session.household.identity).toEqual({
      kind: 'legacy',
      libraryKey: 'same-library-key',
      configurationOnly: false,
    });
    expect(session.content).toBe(contentPort);
    expect(closeWorkerServices).toHaveBeenCalledOnce();
  });

  it('owns only transient toast and undo timing', () => {
    vi.useFakeTimers();
    const session = legacyProfileSession(null, false, null, content());
    const run = vi.fn();
    session.notify('Removed', { holdMs: 10, undo: { label: 'Undo', run } });
    expect(session.toast).toBe('Removed');
    expect(session.undo?.run).toBe(run);
    vi.advanceTimersByTime(10);
    expect(session.toast).toBeNull();
    expect(session.undo).toBeNull();
  });

  it('replaces a future active profile without closing the configuration-only household', () => {
    const householdClose = vi.fn();
    const profileClose = vi.fn();
    const householdForeground = vi.fn().mockResolvedValue(undefined);
    const profileForeground = vi.fn().mockResolvedValue(undefined);
    const householdModel = {
      foregroundReady: householdForeground,
      close: householdClose,
    } as unknown as LibraryModel;
    const profileModel = {
      foregroundReady: profileForeground,
      close: profileClose,
    } as unknown as LibraryModel;
    const household = new HouseholdSession(
      { kind: 'profiles', libraryKey: 'household-key', configurationOnly: true },
      householdModel,
      content(),
    );
    const session = activeProfileSession(
      persistentProfileIdentity(KID_ID, 'kid-library-key'),
      household,
      profileModel,
    );

    session.foregroundReady();
    session.close();

    expect(householdForeground).toHaveBeenCalledOnce();
    expect(profileForeground).toHaveBeenCalledOnce();
    expect(profileClose).toHaveBeenCalledOnce();
    expect(householdClose).not.toHaveBeenCalled();

    household.close();
    expect(householdClose).toHaveBeenCalledOnce();
  });
});
