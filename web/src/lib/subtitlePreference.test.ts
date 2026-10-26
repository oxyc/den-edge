import { beforeEach, describe, expect, it, vi } from 'vitest';
import { syncPolicy } from './syncCore';
import { readSubtitlePreference } from './subtitlePreference';
import type { SettingsRow } from './wire';

vi.mock('./syncCore', () => ({ syncPolicy: vi.fn() }));

const row = (values: SettingsRow['values']): SettingsRow => ({
  kind: 'set',
  schema: 2,
  name: 'prefs',
  values,
});

describe('subtitle preference', () => {
  beforeEach(() => vi.mocked(syncPolicy).mockReset());

  it('reads an absent preference as Automatic without waiting for deferred policy', () => {
    vi.mocked(syncPolicy).mockReturnValue({
      version: 1,
      choice: { mode: 'off' },
    });

    expect(readSubtitlePreference(undefined)).toEqual({ mode: 'automatic' });
    expect(readSubtitlePreference(row({}))).toEqual({ mode: 'automatic' });
    expect(syncPolicy).not.toHaveBeenCalled();
  });
});
