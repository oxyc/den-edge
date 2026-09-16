<!-- Settings › Content, as on the TV: what's hidden from browsing, which services get shelves, the region, the
     year floor, which warnings and ratings show, the player's subtitle list, and the parental limit. Each of the
     TV's pushed screens opens in place here. -->
<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import CheckGrid from './CheckGrid.svelte';
  import { rows } from './rows.svelte';
  import Confirm from './Confirm.svelte';
  import Segmented from './Segmented.svelte';
  import Select from './Select.svelte';
  import SettingRow from './SettingRow.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import Switch from './Switch.svelte';
  import {
    genreEntries,
    LANGUAGES,
    MIN_YEARS,
    MOVIE_GENRES,
    RATING_SOURCES,
    SUBTITLES_PER_LANGUAGE,
    TV_GENRES,
    WARNING_GROUPS,
  } from './catalogs';
  import { fetchCountries, fetchServices, matches, type Country, type Service } from './services';
  import {
    change,
    hashPin,
    pinMatches,
    toggled,
    type PrefChanges,
    type SyncedPrefs,
  } from './values';

  let {
    prefs,
    tmdbKey,
    pin,
    disabled,
    save,
    savePin,
  }: {
    prefs: SyncedPrefs;
    /** What TMDB's country and service directories are asked with: the library's key, or den-edge's. */
    tmdbKey: string;
    /** The parental PIN, when one is set. */
    pin?: string;
    disabled: boolean;
    save: (changes: PrefChanges) => void;
    savePin: (pin: string | null) => Promise<boolean>;
  } = $props();

  const languages = LANGUAGES.map((l) => ({ value: l.code, label: l.name }));
  const regionNames = (() => {
    try {
      return new Intl.DisplayNames(['en'], { type: 'region' });
    } catch {
      return null;
    }
  })();
  /** What Automatic follows: the browser's region, as the TV follows the device's. */
  const deviceRegion = (() => {
    try {
      return new Intl.Locale(navigator.language).region ?? 'US';
    } catch {
      return 'US';
    }
  })();
  const region = $derived(prefs.watchRegion ?? deviceRegion);

  let countries = $state<Country[] | null>(null);
  let countriesFailed = $state(false);
  $effect(() => {
    if (!tmdbKey) return;
    let gone = false;
    fetchCountries(tmdbKey)
      .then((found) => {
        if (!gone) countries = found;
      })
      .catch(() => {
        if (!gone) countriesFailed = true;
      });
    return () => {
      gone = true;
    };
  });
  const countryName = (code: string) =>
    countries?.find((c) => c.code === code)?.name ?? regionNames?.of(code) ?? code;

  // Hidden genres: a genre in both lists shares its id, so hiding it in one hides it in the other.
  const hiddenGenreNames = $derived(
    [
      ...new Set([
        ...[...MOVIE_GENRES, ...TV_GENRES]
          .filter(([id]) => prefs.excludedGenres.includes(id))
          .map(([, name]) => name),
        ...(prefs.hideAnime ? ['Anime'] : []),
      ]),
    ].sort(),
  );
  const genreOptions = (genres: ReadonlyMap<number, string>) =>
    genreEntries(genres).map((e) => ({
      value: e.kind === 'anime' ? ('anime' as const) : e.id,
      label: e.name,
    }));
  function toggleGenre(value: number | 'anime', on: boolean) {
    if (value === 'anime') save(change.hideAnime(on));
    else save(change.excludedGenres(toggled(prefs.excludedGenres, value, on)));
  }

  // My services: one country at a time, as the TV's country screens.
  const servicesOpen = $derived(rows.open.has('my-services'));
  let servicesCountry = $state<string | null>(null);
  const shownCountry = $derived(servicesCountry ?? region);
  let serviceFilter = $state('');
  const directories = new SvelteMap<string, Service[] | 'failed'>();
  $effect(() => {
    const code = shownCountry;
    if (!servicesOpen || !tmdbKey || directories.has(code)) return;
    fetchServices(code, tmdbKey)
      .then((found) => directories.set(code, found))
      .catch(() => directories.set(code, 'failed'));
  });
  const directory = $derived(directories.get(shownCountry));
  const picksByCountry = $derived(
    prefs.services.reduce(
      (counts, pick) => counts.set(pick.country, (counts.get(pick.country) ?? 0) + 1),
      new Map<string, number>(),
    ),
  );
  const countryGroups = $derived.by(() => {
    const picked = [...picksByCountry]
      .filter(([code]) => code !== region)
      .sort((a, b) => b[1] - a[1]);
    const taken = new Set([region, ...picked.map(([code]) => code)]);
    const count = (code: string) => picksByCountry.get(code) ?? 0;
    return [
      {
        label: 'Your region',
        options: [
          {
            value: region,
            label: `${countryName(region)} (your region)${count(region) ? ` — ${count(region)} picked` : ''}`,
          },
        ],
      },
      ...(picked.length
        ? [
            {
              label: 'Countries with picks',
              options: picked.map(([code, n]) => ({
                value: code,
                label: `${countryName(code)} — ${n} picked`,
              })),
            },
          ]
        : []),
      {
        label: 'All countries',
        options: (countries ?? [])
          .filter((c) => !taken.has(c.code))
          .map((c) => ({ value: c.code, label: c.name })),
      },
    ];
  });
  const serviceOptions = $derived(
    Array.isArray(directory)
      ? directory
          .filter((s) => s.name.toLowerCase().includes(serviceFilter.trim().toLowerCase()))
          .map((s) => ({
            value: s.id,
            label: s.name,
            note:
              s.movies && !s.series
                ? '(movies only)'
                : s.series && !s.movies
                  ? '(series only)'
                  : undefined,
          }))
      : [],
  );
  const isPicked = (service: Service, country: string) =>
    prefs.services.some((p) => p.country === country && matches(service, p.id));
  /** The picks named, where their country's services have loaded; a service from another country says which. */
  const pickNames = $derived(
    prefs.services
      .flatMap((pick) => {
        const found = directories.get(pick.country);
        const service = Array.isArray(found) ? found.find((s) => matches(s, pick.id)) : undefined;
        if (!service) return [];
        return [pick.country === region ? service.name : `${service.name} (${pick.country})`];
      })
      .sort(),
  );
  function toggleService(id: number, on: boolean) {
    if (!Array.isArray(directory)) return;
    const service = directory.find((s) => s.id === id);
    if (!service) return;
    const country = shownCountry;
    const rest = prefs.services.filter((p) => !(p.country === country && matches(service, p.id)));
    save(change.services(on ? [...rest, { id: service.id, country }] : rest));
  }

  // Parental controls: once a PIN is set, the limit changes only after it's entered.
  let unlocked = $state(false);
  let pinEntry = $state('');
  let pinWrong = $state(false);
  let newPin = $state('');
  const canChangeLimit = $derived(!pin || unlocked);
  const limitLabel = $derived(
    prefs.maturityCeiling === 'pg13' ? 'PG-13' : prefs.maturityCeiling === 'r' ? 'R' : 'None',
  );
  async function unlock() {
    pinWrong = !(pin && (await pinMatches(pin, pinEntry)));
    if (!pinWrong) unlocked = true;
    pinEntry = '';
  }
  async function setPin() {
    if (!/^\d{4}$/.test(newPin)) return;
    // Hashed before it's written: the library carries the PIN's digest, never the PIN.
    if (await savePin(await hashPin(newPin))) {
      newPin = '';
      unlocked = true;
    }
  }

  const count = (n: number, none: string) => (n ? String(n) : none);
</script>

<SettingsSection
  id="content"
  title="Content"
  footer="Hidden genres, languages, and titles are removed from Home, Browse, and Search. Watched titles you hide stay under Watchlist → Watched."
>
  <SettingRow id="hidden-genres" label="Hidden genres" value={count(hiddenGenreNames.length, '')}>
    <p class="summary">
      <span
        >{hiddenGenreNames.length
          ? `${hiddenGenreNames.length} hidden · ${hiddenGenreNames.join(', ')}`
          : 'None hidden'}</span
      >
      {#if hiddenGenreNames.length}
        <button
          type="button"
          class="link-button"
          {disabled}
          onclick={() => save({ ...change.excludedGenres([]), ...change.hideAnime(false) })}
          >Show all</button
        >
      {/if}
    </p>
    <CheckGrid
      legend="Movies"
      options={genreOptions(MOVIE_GENRES)}
      checked={(v) => (v === 'anime' ? prefs.hideAnime : prefs.excludedGenres.includes(v))}
      hide
      {disabled}
      onchange={toggleGenre}
    />
    <CheckGrid
      legend="TV"
      options={genreOptions(TV_GENRES)}
      checked={(v) => (v === 'anime' ? prefs.hideAnime : prefs.excludedGenres.includes(v))}
      hide
      {disabled}
      onchange={toggleGenre}
    />
    <p class="foot">
      Select a genre to hide every title in it. A genre in both lists, like Comedy or Anime, hides
      in both. To hide by original language (e.g. Hindi), use Hidden languages instead.
    </p>
  </SettingRow>

  <SettingRow
    id="hidden-languages"
    label="Hidden languages"
    value={count(prefs.excludedLanguages.length, '')}
  >
    <CheckGrid
      legend="Languages"
      options={languages}
      checked={(code) => prefs.excludedLanguages.includes(code)}
      hide
      {disabled}
      onchange={(code, on) =>
        save(change.excludedLanguages(toggled(prefs.excludedLanguages, code, on)))}
    />
    <p class="foot">
      Select a language to hide every title in it. Hidden titles are filtered out of Home, Movies,
      Series, and Explore.
    </p>
  </SettingRow>

  <SettingRow id="my-services" label="My services" value={count(prefs.services.length, '')}>
    <p class="summary">
      <span
        >{prefs.services.length
          ? `${prefs.services.length} service${prefs.services.length === 1 ? '' : 's'}${pickNames.length ? ` · ${pickNames.join(', ')}` : ''}`
          : 'None selected'}</span
      >
    </p>
    {#if !tmdbKey}
      <p class="status bad">Couldn’t load the country list. Check your TMDB key in Settings.</p>
    {:else}
      <div class="form">
        <Select
          label="Country"
          value={shownCountry}
          groups={countryGroups}
          boxed
          onchange={(code) => {
            servicesCountry = code;
            serviceFilter = '';
          }}
        />
        <input
          id="service-filter"
          class="field"
          type="search"
          placeholder="Filter {countryName(shownCountry)}’s services"
          aria-label="Filter services"
          bind:value={serviceFilter}
        />
      </div>
      {#if countriesFailed}
        <p class="status bad">Couldn’t load the country list. Check your TMDB key in Settings.</p>
      {/if}
      {#if directory === 'failed'}
        <p class="status bad">
          Couldn’t load {countryName(shownCountry)}’s services. Try again later.
        </p>
      {:else if !directory}
        <p class="status">Loading services…</p>
      {:else if !directory.length}
        <p class="status">No services listed for {countryName(shownCountry)}</p>
      {:else}
        <CheckGrid
          legend="{countryName(shownCountry)} · most prominent first"
          options={serviceOptions}
          checked={(id) => {
            const service = directory.find((s) => s.id === id);
            return !!service && isPicked(service, shownCountry);
          }}
          wide
          {disabled}
          onchange={toggleService}
        />
      {/if}
    {/if}
    <p class="foot">
      Services are licensed per country, so pick them by country. Each becomes a brand tile on Home,
      opening that country’s catalogue. Every pick shares the one shelf, and a tile says which
      country it is for when you have picked the same service twice. The “where to watch” badges on
      individual titles still follow your own region.
    </p>
    <p class="foot">Streaming availability by JustWatch.</p>
  </SettingRow>

  <SettingRow id="region" label="Region">
    {#snippet control()}
      <Select
        labelledby="region-label"
        value={prefs.watchRegion ?? ''}
        options={[
          { value: '', label: `Automatic (${countryName(deviceRegion)})` },
          ...(countries ?? []).map((c) => ({ value: c.code, label: c.name })),
          ...(prefs.watchRegion && !countries?.some((c) => c.code === prefs.watchRegion)
            ? [{ value: prefs.watchRegion, label: countryName(prefs.watchRegion) }]
            : []),
        ]}
        {disabled}
        onchange={(code) => save(change.watchRegion(code || undefined))}
      />
    {/snippet}
  </SettingRow>

  <SettingRow id="minimum-year" label="Minimum year">
    {#snippet control()}
      <Select
        labelledby="minimum-year-label"
        value={String(prefs.minReleaseYear ?? '')}
        options={MIN_YEARS.map((o) => ({ value: String(o.year ?? ''), label: o.label }))}
        {disabled}
        onchange={(year) => save(change.minReleaseYear(year ? Number(year) : undefined))}
      />
    {/snippet}
  </SettingRow>

  <SettingRow
    id="content-warnings"
    label="Content warnings"
    value={count(prefs.shownWarnings.length, 'All')}
  >
    <p class="summary">
      <span
        >{prefs.shownWarnings.length
          ? `${prefs.shownWarnings.length} shown · ${[...prefs.shownWarnings].sort().join(', ')}`
          : 'All confirmed warnings show'}</span
      >
      {#if prefs.shownWarnings.length}
        <button
          type="button"
          class="link-button"
          {disabled}
          onclick={() => save(change.shownWarnings([]))}>Show all</button
        >
      {/if}
    </p>
    <div class="warning-groups">
      {#each WARNING_GROUPS as group (group.name)}
        <CheckGrid
          legend={group.name}
          options={group.categories.map((c) => ({ value: c, label: c }))}
          checked={(c) => prefs.shownWarnings.includes(c)}
          stacked
          {disabled}
          onchange={(c, on) => save(change.shownWarnings(toggled(prefs.shownWarnings, c, on)))}
        />
      {/each}
    </div>
    <p class="foot">
      Which warnings show on detail pages. Leave everything off to show every confirmed warning;
      pick some to see only those.
    </p>
  </SettingRow>

  <SettingRow
    id="visible-subtitle-languages"
    label="Visible subtitle languages"
    value={count(prefs.shownSubtitleLanguages.length, 'All')}
  >
    <CheckGrid
      legend="Languages"
      options={languages}
      checked={(code) => prefs.shownSubtitleLanguages.includes(code)}
      {disabled}
      onchange={(code, on) =>
        save(change.shownSubtitleLanguages(toggled(prefs.shownSubtitleLanguages, code, on)))}
    />
    <p class="foot">
      Show only the selected subtitle languages in the player. Select none to show every language a
      title offers.
    </p>
  </SettingRow>

  <SettingRow id="subtitles-per-language" label="Subtitles per language">
    {#snippet control()}
      <Segmented
        name="subtitles-per-language"
        labelledby="subtitles-per-language-label"
        options={SUBTITLES_PER_LANGUAGE.map((o) => ({ value: o.count, label: o.label }))}
        value={prefs.subtitlesPerLanguage}
        {disabled}
        onchange={(n) => save(change.subtitlesPerLanguage(n))}
      />
    {/snippet}
  </SettingRow>

  <SettingRow id="hide-watched" label="Hide watched">
    {#snippet control()}
      <Switch
        labelledby="hide-watched-label"
        checked={prefs.hideWatched}
        {disabled}
        onchange={(on) => save(change.hideWatched(on))}
      />
    {/snippet}
  </SettingRow>

  <SettingRow
    id="ratings-shown"
    label="Ratings shown"
    value="{prefs.ratingSources.length} of {RATING_SOURCES.length}"
  >
    <CheckGrid
      legend="Sources"
      options={RATING_SOURCES.map((s) => ({ value: s.id, label: s.name }))}
      checked={(id) => prefs.ratingSources.includes(id)}
      {disabled}
      onchange={(id, on) => save(change.ratingSources(toggled(prefs.ratingSources, id, on)))}
    />
    <p class="foot">Choose which ratings show on detail pages. Cards show TMDB only.</p>
  </SettingRow>

  <SettingRow id="parental-controls" label="Parental controls" value={limitLabel}>
    <h3 id="maturity-ceiling">Maturity ceiling</h3>
    <Segmented
      name="maturity-ceiling"
      labelledby="maturity-ceiling"
      options={[
        { value: 'none', label: 'None' },
        { value: 'pg13', label: 'PG-13' },
        { value: 'r', label: 'R' },
      ]}
      value={prefs.maturityCeiling ?? 'none'}
      disabled={disabled || !canChangeLimit}
      onchange={(v) => save(change.maturityCeiling(v === 'pg13' || v === 'r' ? v : undefined))}
    />
    {#if pin && !unlocked}
      <form
        class="form"
        onsubmit={(event) => {
          event.preventDefault();
          unlock();
        }}
      >
        <input
          id="parental-pin"
          class="field short"
          type="password"
          inputmode="numeric"
          autocomplete="off"
          maxlength="4"
          placeholder="Parental PIN"
          aria-label="Parental PIN"
          bind:value={pinEntry}
        />
        <button class="primary" disabled={pinEntry.length < 4}>Unlock</button>
      </form>
      {#if pinWrong}<p class="status bad" role="alert">Wrong PIN.</p>{/if}
      <p class="foot">A PIN protects the maturity ceiling. Enter it to change the ceiling.</p>
    {:else}
      <h3>{pin ? 'Change PIN' : 'PIN'}</h3>
      <form
        class="form"
        onsubmit={(event) => {
          event.preventDefault();
          void setPin();
        }}
      >
        <input
          id="new-parental-pin"
          class="field short"
          type="password"
          inputmode="numeric"
          autocomplete="new-password"
          maxlength="4"
          placeholder={pin ? 'New 4-digit PIN' : 'Set a 4-digit PIN'}
          aria-label={pin ? 'New parental PIN' : 'Set a parental PIN'}
          bind:value={newPin}
        />
        <button class="primary" disabled={disabled || !/^\d{4}$/.test(newPin)}
          >{pin ? 'Change PIN' : 'Set PIN'}</button
        >
        {#if pin}
          <Confirm
            label="Remove PIN"
            question="Remove the parental PIN?"
            detail="Anyone could then change the maturity ceiling, on every device."
            confirmLabel="Remove"
            {disabled}
            onconfirm={() => void savePin(null)}
          />
        {/if}
      </form>
      <p class="foot">
        A PIN protects the maturity ceiling. It reaches your Apple TVs through your library, and a
        looser ceiling set here waits on each Apple TV until someone enters the PIN there.
      </p>
    {/if}
  </SettingRow>
</SettingsSection>

<style>
  /* Four digits need no more room; `input` outweighs the page's shared field style. */
  input.short {
    flex: 0 1 200px;
  }

  /* Ten short groups as columns of lists, the way the TV lists each group under its heading. */
  .warning-groups {
    margin-top: 8px;
    columns: 200px;
    column-gap: 24px;
  }
</style>
