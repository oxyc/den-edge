<!-- Home's below-the-fold catalogue is one lazy rendering tail: none of its row/credit code is parsed before the
     personal shelves, hero and first poster. Direct browse routes admit this component immediately. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { RowDef } from '../lib/catalog';
  import type { Title } from '../lib/library';
  import type { ProfileSession } from '../lib/profileSession.svelte';
  import type { ServicePick } from '../lib/prefs';
  import { i18n } from '../lib/i18n.svelte';
  import { optionalImport } from '../lib/keyboardNavigation';
  import type { Service, ServiceDirectoryLoad } from '../settings/services';
  import Browse from './Browse.svelte';
  import ServicesRow from './ServicesRow.svelte';

  let {
    rows,
    shown,
    browseReady,
    browseIdentity,
    showServices,
    serviceSession,
    servicePicks = [],
    serviceResolver,
    onServiceState,
    onServiceIntent,
  }: {
    rows: RowDef[];
    shown: (title: Title) => boolean;
    /** Home waits for its visible provider names so catalogue rows load once with their final captions. */
    browseReady: boolean;
    browseIdentity: string;
    showServices: boolean;
    serviceSession?: ProfileSession;
    servicePicks?: readonly ServicePick[];
    serviceResolver?: typeof import('../lib/services') | null;
    onServiceState?: (state: {
      owner: ProfileSession;
      language: string;
      picks: readonly ServicePick[];
      names: Record<number, string>;
      settled: boolean;
    }) => void;
    onServiceIntent: (service: Service, country: string) => void;
  } = $props();

  /** Home's provider directory is part of this existing below-fold chunk, not Library's startup graph. */
  let serviceDirectoriesAdmitted = $state(false);
  let directoryServices = $state.raw<typeof import('../settings/services') | null>(null);
  let directoryModuleState = $state<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  $effect(() => {
    if (!showServices || !serviceDirectoriesAdmitted || directoryServices) return;
    directoryModuleState = 'loading';
    let current = true;
    void optionalImport(import('../settings/services')).then(
      (directory) => {
        if (!current) return;
        directoryServices = directory;
        directoryModuleState = 'ready';
      },
      () => {
        if (!current) return;
        directoryModuleState = 'failed';
      },
    );
    return () => {
      current = false;
    };
  });
  let directoryLoads = $state.raw<Record<string, ServiceDirectoryLoad>>({});
  const directoryKey = (language: string, country: string) => `${language}:${country}`;
  let directoryRequest = 0;
  let directoryRetry = $state(0);
  const refreshDirectories: Record<string, true> = {};
  let retryingDirectories = $state.raw<Record<string, true>>({});
  let directoryOwner = $state.raw<ProfileSession | undefined>();
  let directoryOwnerRevision = $state(0);
  $effect(() => {
    const owner = serviceSession;
    if (owner === directoryOwner) return;
    directoryOwner = owner;
    directoryOwnerRevision++;
  });
  const currentDirectoryKeys = $derived([
    ...new Set(
      servicePicks.map(
        ({ country }) => `${directoryOwnerRevision}:${directoryKey(i18n.language, country)}`,
      ),
    ),
  ]);
  const naming = $derived(
    currentDirectoryKeys.filter((key) => directoryLoads[key]?.status === 'loading').length,
  );
  const failedDirectories = $derived(
    currentDirectoryKeys.filter((key) => {
      const status = directoryLoads[key]?.status;
      return status === 'partial' || status === 'failed';
    }),
  );
  const directoryRetrying = $derived(currentDirectoryKeys.some((key) => retryingDirectories[key]));
  $effect(() => {
    const directory = directoryServices;
    const owner = serviceSession;
    const language = i18n.language;
    void directoryRetry;
    if (!showServices || !serviceDirectoriesAdmitted || !directory || !owner) return;
    let current = true;
    const activeKeys = new Set(currentDirectoryKeys);
    const loads = untrack(() => directoryLoads);
    if (Object.keys(loads).some((key) => !activeKeys.has(key))) {
      directoryLoads = Object.fromEntries(
        Object.entries(loads).filter(([key]) => activeKeys.has(key)),
      );
    }
    const retrying = untrack(() => retryingDirectories);
    if (Object.keys(retrying).some((key) => !activeKeys.has(key))) {
      retryingDirectories = Object.fromEntries(
        Object.entries(retrying).filter(([key]) => activeKeys.has(key)),
      );
    }
    for (const country of new Set(servicePicks.map((pick) => pick.country))) {
      const key = `${directoryOwnerRevision}:${directoryKey(language, country)}`;
      const previous = untrack(() => directoryLoads[key]);
      const refresh = refreshDirectories[key] === true;
      delete refreshDirectories[key];
      if (previous && !refresh) continue;
      const request = ++directoryRequest;
      directoryLoads = {
        ...untrack(() => directoryLoads),
        [key]: directory.beginServiceDirectoryLoad(previous, request),
      };
      void directory
        .contentServicesResult(owner.content, country, refresh, language)
        .then(
          (result) => {
            if (!current) return;
            const owned = untrack(() => directoryLoads[key]);
            if (!owned) return;
            directoryLoads = {
              ...untrack(() => directoryLoads),
              [key]: directory.completeServiceDirectoryLoad(owned, request, result),
            };
          },
          () => {
            if (!current) return;
            const owned = untrack(() => directoryLoads[key]);
            if (!owned) return;
            directoryLoads = {
              ...untrack(() => directoryLoads),
              [key]: directory.failServiceDirectoryLoad(owned, request),
            };
          },
        )
        .finally(() => {
          if (!current) return;
          if (untrack(() => retryingDirectories[key])) {
            const { [key]: _finished, ...rest } = untrack(() => retryingDirectories);
            retryingDirectories = rest;
          }
        });
    }
    return () => (current = false);
  });
  function retryServiceDirectories() {
    if (directoryRetrying || !failedDirectories.length) return;
    for (const key of failedDirectories) refreshDirectories[key] = true;
    retryingDirectories = Object.fromEntries(failedDirectories.map((key) => [key, true]));
    directoryRetry++;
  }
  const services = $derived(
    [...new Set(servicePicks.map((pick) => pick.country))].flatMap(
      (country) =>
        serviceResolver?.resolvePicks(
          servicePicks,
          directoryLoads[`${directoryOwnerRevision}:${directoryKey(i18n.language, country)}`]
            ?.services ?? [],
          country,
        ) ?? [],
    ),
  );
  const serviceNames: Record<number, string> = $derived(
    Object.fromEntries(
      services.flatMap(({ service }) =>
        [service.id, ...service.variants].map((id) => [id, service.name]),
      ),
    ),
  );
  const directoriesSettled = $derived(
    serviceDirectoriesAdmitted &&
      (directoryModuleState === 'failed' ||
        (!!directoryServices &&
          naming === 0 &&
          currentDirectoryKeys.every((key) => directoryLoads[key]))),
  );
  $effect(() => {
    const owner = serviceSession;
    const publish = onServiceState;
    if (!showServices || !owner || !publish) return;
    publish({
      owner,
      language: i18n.language,
      picks: servicePicks,
      names: serviceNames,
      settled: directoriesSettled,
    });
  });
</script>

{#if showServices}
  <ServicesRow
    {services}
    pending={serviceDirectoriesAdmitted
      ? directoryModuleState === 'loading' || naming
        ? servicePicks.length
        : 0
      : servicePicks.length}
    empty={serviceDirectoriesAdmitted &&
    !naming &&
    !services.length &&
    (directoryModuleState === 'failed' || !failedDirectories.length)
      ? 'Services unavailable'
      : undefined}
    failure={!naming && failedDirectories.length ? 'Services unavailable' : undefined}
    retrying={directoryRetrying}
    onretry={retryServiceDirectories}
    onvisible={() => (serviceDirectoriesAdmitted = true)}
    onintent={onServiceIntent}
  />
{/if}
{#if browseReady}<Browse {rows} {shown} identity={browseIdentity} />{/if}
