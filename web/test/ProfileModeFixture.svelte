<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import ProfileOwnerGate from '../src/components/ProfileOwnerGate.svelte';
  import ProfileSwitcher from '../src/components/ProfileSwitcher.svelte';
  import MobileProfileRow from '../src/components/MobileProfileRow.svelte';
  import NavigationBar from '../src/components/NavigationBar.svelte';
  import ProfileSettings from '../src/ProfileSettings.svelte';
  import ContentSection from '../src/settings/ContentSection.svelte';
  import { HouseholdSession } from '../src/lib/householdSession.svelte';
  import type {
    LibraryModel,
    LibraryModelLease,
    LibraryModelSnapshot,
  } from '../src/lib/libraryModel.svelte';
  import type { ConnectionsView } from '../src/lib/libraryServiceProtocol';
  import { legacyProfileIdentity, profileId, profileSessionKey } from '../src/lib/profileIdentity';
  import { scopeRecentSearches } from '../src/lib/recentSearches';
  import { parseRoute } from '../src/lib/route';
  import {
    ProfileModeCoordinator,
    previewProfileDirectory,
    profilesCapability,
    type ProfilesCapability,
  } from '../src/lib/profileModeCoordinator.svelte';
  import { ProfileSession } from '../src/lib/profileSession.svelte';
  import type {
    VisitorActivityLock,
    VisitorProfileSession,
  } from '../src/lib/visitorProfileSession.svelte';

  const params = new URLSearchParams(location.search);
  const configured = params.get('pin') !== 'none';
  const connectionsMode = params.get('connections');
  const connectionFailures = Number(
    params.get('connectionFailures') ?? (connectionsMode === 'repeat' ? 1 : 0),
  );
  if (params.has('orphan'))
    localStorage.setItem(
      'den.profile.visitor.v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:activity',
      JSON.stringify({ retained: true }),
    );
  let connectionSubscriptions = $state(1);
  let connectionRetries = 0;
  let connectionReleases = 0;
  let connectionsSnapshot = $state.raw<LibraryModelSnapshot<ConnectionsView>>(
    connectionsMode
      ? {
          connection: 'failed',
          ...(connectionsMode === 'stale'
            ? {
                value: {
                  kind: 'connections',
                  parentalPinConfigured: false,
                  parentalPinDelivery: 'synced',
                } as ConnectionsView,
              }
            : {}),
          error: {
            code: 'unavailable',
            message: 'fixture Connections selection failed',
            retryable: true,
          },
        }
      : {
          connection: 'ready',
          value: {
            kind: 'connections',
            parentalPinConfigured: configured,
            parentalPinDelivery: 'synced',
          } as ConnectionsView,
        },
  );
  const connectionsLease: LibraryModelLease<ConnectionsView> = {
    get snapshot() {
      return connectionsSnapshot;
    },
    rebind() {
      if (connectionsSnapshot.connection !== 'failed') return false;
      connectionSubscriptions++;
      const attempt = ++connectionRetries;
      connectionsSnapshot = { connection: 'connecting' };
      queueMicrotask(() => {
        connectionsSnapshot =
          attempt <= connectionFailures
            ? {
                connection: 'failed',
                error: {
                  code: 'unavailable',
                  message: `fixture Connections selection failed ${attempt}`,
                  retryable: true,
                },
              }
            : {
                connection: 'ready',
                value: {
                  kind: 'connections',
                  parentalPinConfigured: configured,
                  parentalPinDelivery: 'synced',
                } as ConnectionsView,
              };
      });
      return true;
    },
    release() {
      connectionReleases++;
    },
  };
  let lockAttempts = 0;
  const visitorLock: VisitorActivityLock | undefined =
    params.has('rejectLock') || params.has('slowLock')
      ? {
          available: () => true,
          async run<T>(_name: string, work: () => Promise<T> | T): Promise<T> {
            if (lockAttempts++ === 2) throw new Error('fixture lock refused');
            if (params.has('slowLock')) await new Promise((resolve) => setTimeout(resolve, 1000));
            return work();
          },
        }
      : undefined;
  const model = {
    settings: {
      connection: 'ready',
      value: {
        kind: 'settings',
        assistant: { read: true, write: true },
        preferences: {
          excludedGenres: [27],
          excludedLanguages: ['sv'],
          hideAnime: true,
          hideWatched: true,
          minReleaseYear: 1999,
          audioLanguage: 'sv',
          subtitleLanguage: 'fi',
          shownSubtitleLanguages: ['sv'],
          subtitlesPerLanguage: 1,
          autoSkipSegments: true,
          autoplayTrailers: false,
          ratingSources: [],
          shownWarnings: ['violence'],
          watchRegion: 'FI',
          services: [{ id: 8, country: 'FI' }],
          servicesConfigured: true,
          maturityCeiling: 'pg13',
        },
      },
    },
    connections: () => connectionsLease,
    verifyParentalPin: async (pin: string) => pin === '1234',
    close: () => {},
  } as unknown as LibraryModel;
  const household = new HouseholdSession(
    { kind: 'legacy', libraryKey: 'fixture-household', configurationOnly: false },
    model,
    {
      query: async (request) =>
        request.kind === 'service.regions'
          ? { regions: [{ code: 'FI', name: 'Finland' }] }
          : request.kind === 'service.directory'
            ? { services: [], complete: true }
            : {},
      onStatus: () => () => {},
    },
  );
  const owner = new ProfileSession(
    legacyProfileIdentity('fixture-household', false),
    household,
    model,
    false,
    true,
  );
  let policy = $state<{ maximumAge: number | null; unknownRatings: 'allow' | 'block' }>({
    maximumAge: 12,
    unknownRatings: 'block',
  });
  let profiles = $state.raw<ProfileModeCoordinator | null>(null);
  let checked = $state(false);
  let capability = $state<ProfilesCapability | 'checking'>('checking');
  const previewDirectory = previewProfileDirectory();
  const fixtureDirectory = params.has('twoKids')
    ? {
        ...previewDirectory,
        profiles: [
          ...previewDirectory.profiles,
          {
            ...previewDirectory.profiles[1]!,
            id: profileId('00000000000000000000000000000003'),
            name: 'Kids Two',
          },
        ],
      }
    : previewDirectory;

  const fixture = {
    snapshot() {
      return {
        enabled: profiles !== null,
        checked,
        capability,
        mode: profiles?.mode ?? 'owner',
        visitId: profiles?.mode === 'visitor' ? profiles.session!.identity.id : null,
        policyCeiling: profiles?.session?.policy?.settings.value?.preferences.maturityCeiling,
        effectivePreferences: profiles?.session?.policy?.settings.value?.preferences,
        contentPolicy: profiles?.session?.contentPolicy,
        preferencesIdentity: profiles?.session?.preferences?.identity,
        policyKeys: profiles?.session?.policy ? Object.keys(profiles.session.policy) : [],
        policyHasWriter: profiles?.session?.policy
          ? 'commands' in profiles.session.policy || 'track' in profiles.session.policy
          : false,
        householdExposesModel: profiles?.session ? 'model' in profiles.session.household : false,
        servicesExposeModel: profiles?.session ? 'model' in profiles.session.services : false,
        parentalControls: profiles
          ? {
              kind:
                profiles.parentalControls === null
                  ? 'failed'
                  : profiles.parentalControls === undefined
                    ? 'loading'
                    : 'ready',
              ...(typeof profiles.parentalControls === 'boolean'
                ? { configured: profiles.parentalControls }
                : {}),
              ...(profiles.parentalControls === null ? { error: connectionsSnapshot.error } : {}),
            }
          : null,
        connectionSubscriptions,
        connectionRetries,
        connectionReleases,
        watchlist:
          (profiles?.session as VisitorProfileSession | undefined)?.profileActivity?.watchlist.map(
            ({ title }) => title,
          ) ?? [],
        continueWatching:
          (
            profiles?.session as VisitorProfileSession | undefined
          )?.profileActivity?.continueWatching.map(({ title, fraction }) => ({
            title: title.title,
            fraction,
          })) ?? [],
        watched:
          (profiles?.session as VisitorProfileSession | undefined)?.profileActivity?.history.map(
            ({ title }) => title.title,
          ) ?? [],
        keys: Object.keys(localStorage).sort(),
      };
    },
    setActivity(key: string, value: string) {
      return (profiles?.session as VisitorProfileSession).activity.set(key, value);
    },
    getActivity(key: string) {
      return (profiles?.session as VisitorProfileSession).activity.get(key);
    },
    async addVisitorActivity() {
      const activity = (profiles?.session as VisitorProfileSession).profileActivity!;
      await activity.setWatchlisted({ type: 'movie', id: 550, title: 'Fight Club' }, true);
      await activity.recordProgress({ type: 'tv', id: 1399, title: 'Game of Thrones' }, 0.4, 1200, {
        season: 2,
        episode: 3,
      });
      await activity.setWatched({ type: 'movie', id: 603, title: 'The Matrix' }, true);
    },
    async addVisitorWatchlist(id: number, title: string) {
      const activity = (profiles?.session as VisitorProfileSession | undefined)?.profileActivity;
      if (!activity) return 'inactive';
      try {
        await activity.setWatchlisted({ type: 'movie', id, title }, true);
        return 'saved';
      } catch (error) {
        return error instanceof Error ? error.message : 'failed';
      }
    },
  };

  onMount(() => {
    let current = true;
    (window as typeof window & { denProfileModeFixture?: typeof fixture }).denProfileModeFixture =
      fixture;
    void profilesCapability(fetch, visitorLock).then((answer) => {
      if (!current) return;
      capability = answer;
      if (answer === 'enabled' || answer === 'preview')
        profiles = new ProfileModeCoordinator(
          owner,
          localStorage,
          window,
          visitorLock,
          answer === 'preview' ? fixtureDirectory : null,
        );
      checked = true;
    });
    return () => {
      current = false;
      delete (window as typeof window & { denProfileModeFixture?: typeof fixture })
        .denProfileModeFixture;
    };
  });

  onDestroy(() => (profiles ? profiles.dispose() : owner.close()));

  $effect(() => {
    if (profiles && !profiles.session) profiles.establishUnprotectedOwner();
  });
  $effect(() => {
    const active = profiles?.session;
    if (active)
      scopeRecentSearches(active.administersHousehold, profileSessionKey(active.identity));
  });
</script>

<main>
  {#if !checked}
    <p role="status">Checking profiles…</p>
  {:else if capability === 'indeterminate'}
    <section aria-labelledby="profile-unavailable-title">
      <h1 id="profile-unavailable-title">Profiles couldn’t be opened</h1>
      <p>The Owner library remains hidden. Reload Den to try again.</p>
    </section>
  {:else if profiles?.session}
    {#if params.has('recentSearches')}
      {#key profileSessionKey(profiles.session.identity)}
        <NavigationBar route={parseRoute('/search')} />
      {/key}
    {/if}
    <ProfileSwitcher {profiles} hideOnMobile />
    <MobileProfileRow {profiles} />
    <p data-mode>
      {profiles.mode === 'owner'
        ? 'Owner active'
        : profiles.mode === 'kid'
          ? 'Kids active'
          : 'Visitor active'}
    </p>
    {#if profiles.mode === 'visitor'}
      <p>Visitor can’t manage household settings.</p>
      <button type="button" onclick={() => void fixture.addVisitorActivity()}>Add activity</button>
      <section aria-label="Visitor watchlist">
        {#each profiles.session.profileActivity?.watchlist ?? [] as title (title.id)}
          <span>{title.title}</span>
        {/each}
      </section>
      <section aria-label="Visitor Continue Watching">
        {#each profiles.session.profileActivity?.continueWatching ?? [] as entry (entry.title.id)}
          <span>{entry.title.title} {Math.round(entry.fraction * 100)}%</span>
        {/each}
      </section>
      <section aria-label="Visitor watched">
        {#each profiles.session.profileActivity?.history ?? [] as entry (entry.title.id)}
          <span>{entry.title.title}</span>
        {/each}
      </section>
    {/if}
    {#if params.has('settings') && profiles.mode !== 'owner'}
      {#key profiles.session.identity}
        <ProfileSettings
          session={profiles.session}
          profiles={params.has('locked') ? profiles : null}
        />
      {/key}
    {/if}
    <!-- A Kid's Settings once the Owner PIN has opened them: the preview directory takes no policy writes, so the
         editable Content limit rows are rendered here with a stand-in writer. -->
    {#if params.has('contentLimit') && profiles.mode === 'kid' && profiles.session.preferences?.value}
      <ContentSection
        prefs={profiles.session.preferences.value}
        content={profiles.session.content}
        pinConfigured={false}
        disabled={false}
        save={() => {}}
        savePin={async () => false}
        verifyPin={async () => false}
        personalOnly
        contentPolicy={policy}
        role="kid"
        onpolicy={async (next) => ((policy = next), true)}
      />
    {/if}
  {:else if profiles}
    <ProfileOwnerGate {profiles} />
  {:else}
    <p data-mode>Legacy Owner active</p>
  {/if}
</main>

<style>
  main {
    display: grid;
    gap: 16px;
    max-width: 480px;
    margin: 40px auto;
  }
</style>
