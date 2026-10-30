<!-- Settings › Playback, as on the TV: the languages the player picks, and what plays by itself. -->
<script lang="ts">
  import { LANGUAGES } from './catalogs';
  import Select from './Select.svelte';
  import SettingRow from './SettingRow.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import Switch from './Switch.svelte';
  import {
    preferenceChange as change,
    type PreferenceChanges,
    type SettingsPreferences,
  } from './preferences';
  import { i18n } from '../lib/i18n.svelte';

  let {
    prefs,
    disabled,
    save,
  }: {
    prefs: SettingsPreferences;
    disabled: boolean;
    save: (changes: PreferenceChanges) => void;
  } = $props();

  const languages = LANGUAGES.map((l) => ({ value: l.code, label: l.name }));
</script>

<SettingsSection id="playback" title={i18n.text('settings.section.playback')}>
  <SettingRow id="interface-language" label={i18n.text('settings.interfaceLanguage')}>
    {#snippet control()}
      <Select
        labelledby="interface-language-label"
        value={prefs.interfaceLanguage ?? 'en'}
        options={[
          { value: 'en', label: 'English' },
          { value: 'es', label: 'Español' },
          { value: 'sv', label: 'Svenska' },
        ]}
        {disabled}
        onchange={(language) =>
          save(
            change.interfaceLanguage(language === 'es' ? 'es' : language === 'sv' ? 'sv' : 'en'),
          )}
      />
    {/snippet}
  </SettingRow>
  <SettingRow
    id="audio-language"
    label={i18n.text('settings.audioLanguage')}
    detail={i18n.text('settings.originalDefault')}
  >
    {#snippet control()}
      <Select
        label={i18n.text('settings.audioLanguage')}
        value={prefs.audioLanguage ?? ''}
        options={[{ value: '', label: i18n.text('settings.original') }, ...languages]}
        {disabled}
        onchange={(code) => save(change.audioLanguage(code || undefined))}
      />
    {/snippet}
  </SettingRow>
  <SettingRow
    id="subtitle-language"
    label={i18n.text('settings.subtitleLanguage')}
    detail={i18n.text('settings.automaticFollowsInterface')}
  >
    {#snippet control()}
      <Select
        label={i18n.text('settings.subtitleLanguage')}
        value={prefs.hasExplicitSubtitlePreference
          ? (prefs.subtitleLanguage ?? '__off')
          : '__automatic'}
        options={[
          { value: '__automatic', label: i18n.text('settings.automatic') },
          { value: '__off', label: i18n.text('settings.off') },
          ...languages,
        ]}
        {disabled}
        onchange={(code) =>
          save(
            change.subtitlePreference(
              code === '__automatic'
                ? { mode: 'automatic' }
                : code === '__off'
                  ? { mode: 'off' }
                  : { mode: 'language', language: code },
            ),
          )}
      />
    {/snippet}
  </SettingRow>
  <SettingRow id="auto-skip" label={i18n.text('settings.autoSkip')}>
    {#snippet control()}
      <Switch
        labelledby="auto-skip-label"
        checked={prefs.autoSkipSegments}
        {disabled}
        onchange={(on) => save(change.autoSkipSegments(on))}
      />
    {/snippet}
  </SettingRow>
  <SettingRow id="autoplay-trailers" label={i18n.text('settings.autoplayTrailers')}>
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
