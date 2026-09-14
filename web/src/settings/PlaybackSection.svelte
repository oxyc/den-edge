<!-- Settings › Playback, as on the TV: the languages the player picks, and what plays by itself. -->
<script lang="ts">
  import { LANGUAGES } from './catalogs';
  import Select from './Select.svelte';
  import SettingRow from './SettingRow.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import Switch from './Switch.svelte';
  import { change, type PrefChanges, type SyncedPrefs } from './values';

  let {
    prefs,
    disabled,
    save,
  }: { prefs: SyncedPrefs; disabled: boolean; save: (changes: PrefChanges) => void } = $props();

  const languages = LANGUAGES.map((l) => ({ value: l.code, label: l.name }));
</script>

<SettingsSection id="playback" title="Playback">
  <SettingRow id="audio-language" label="Audio language">
    {#snippet control()}
      <Select
        labelledby="audio-language-label"
        value={prefs.audioLanguage ?? ''}
        options={[{ value: '', label: 'Original' }, ...languages]}
        {disabled}
        onchange={(code) => save(change.audioLanguage(code || undefined))}
      />
    {/snippet}
  </SettingRow>
  <SettingRow id="subtitle-language" label="Subtitle language">
    {#snippet control()}
      <Select
        labelledby="subtitle-language-label"
        value={prefs.subtitleLanguage ?? ''}
        options={[{ value: '', label: 'Off' }, ...languages]}
        {disabled}
        onchange={(code) => save(change.subtitleLanguage(code || undefined))}
      />
    {/snippet}
  </SettingRow>
  <SettingRow id="auto-skip" label="Auto-skip intros & credits">
    {#snippet control()}
      <Switch
        labelledby="auto-skip-label"
        checked={prefs.autoSkipSegments}
        {disabled}
        onchange={(on) => save(change.autoSkipSegments(on))}
      />
    {/snippet}
  </SettingRow>
  <SettingRow id="autoplay-trailers" label="Autoplay trailers on detail pages">
    {#snippet control()}
      <Switch
        labelledby="autoplay-trailers-label"
        checked={prefs.autoplayTrailers}
        {disabled}
        onchange={(on) => save(change.autoplayTrailers(on))}
      />
    {/snippet}
  </SettingRow>
</SettingsSection>
