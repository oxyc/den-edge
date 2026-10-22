import { describe, expect, it } from 'vitest';
import { GRANTS_ROW } from './libraryAssistantAuthority';
import {
  selectedDevicesView,
  selectedRuntimeView,
  selectedSettingsView,
} from './librarySelectedSettings';
import type { SettingsRow, Stamp } from './wire';

const stamp = (): Stamp => [1, 0, 'device'];
const setting = (name: string, values: SettingsRow['values']): SettingsRow => ({
  kind: 'set',
  schema: 2,
  name,
  values,
});

describe('selected library settings', () => {
  it('projects settings, devices, and runtime from only their named rows', () => {
    const prefs = setting('prefs', {
      'den.preferredAudioLanguage': { value: { string: 'sv' }, at: stamp() },
      'den.maxSubtitlesPerLanguage': { value: { int: 5 }, at: stamp() },
    });
    expect(selectedSettingsView([prefs])).toMatchObject({
      kind: 'settings',
      preferences: { audioLanguage: 'sv', subtitlesPerLanguage: 5 },
      assistant: { read: false, write: false },
    });

    const devices = setting('devices', {
      'tv.name': { value: { string: 'Living Room' }, at: stamp() },
      'tv.kind': { value: { string: 'tv' }, at: stamp() },
    });
    expect(selectedDevicesView([devices])).toEqual({
      kind: 'devices',
      devices: [{ id: 'tv', name: 'Living Room', kind: 'tv' }],
    });

    expect(selectedRuntimeView([])).toEqual({
      kind: 'runtime',
      pluginManifestUrls: [],
      privateRemuxUrl: null,
    });
  });

  it('forces full policy for assistant state and hides household prefs after a profile split', () => {
    const prefs = setting('prefs', {
      'den.preferredAudioLanguage': { value: { string: 'sv' }, at: stamp() },
    });
    const grants = setting(GRANTS_ROW, {
      assistant: { value: { bool: true }, at: stamp() },
    });
    expect(selectedSettingsView([prefs, grants])).toBeNull();
    expect(selectedSettingsView([prefs], true)?.preferences.audioLanguage).toBeUndefined();
  });
});
