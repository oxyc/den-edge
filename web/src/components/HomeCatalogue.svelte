<!-- Home's below-the-fold catalogue is one lazy rendering tail: none of its row/credit code is parsed before the
     personal shelves, hero and first poster. Direct browse routes admit this component immediately. -->
<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import type { RowDef } from '../lib/catalog';
  import type { Title } from '../lib/library';
  import type { ProfileSession } from '../lib/profileSession.svelte';
  import type { ServicePick } from '../lib/prefs';
  import type { InterfaceLanguage } from '../lib/interfaceLanguage';
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
    serviceResolver?: Pick<typeof import('../lib/services'), 'resolvePicks'> | null;
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
  let directoryModuleFailed = $state(false);
  $effect(() => {
    if (!showServices || !serviceDirectoriesAdmitted || directoryServices) return;
    let current = true;
    void optionalImport(import('../settings/services')).then(
      (directory) => {
        if (!current) return;
        directoryServices = directory;
      },
      () => {
        if (current) directoryModuleFailed = true;
      },
    );
    return () => {
      current = false;
    };
  });
  const directoryLoads = new SvelteMap<string, ServiceDirectoryLoad>();
  const directoryKey = (language: string, country: string) => `${language}:${country}`;
  let directoryRequest = 0;
  let retryingDirectories = $state(0);
  let directoryOwner = $state.raw<ProfileSession>();
  let directoryLanguage = $state<InterfaceLanguage>();
  let directoryPicks = $state.raw<readonly ServicePick[]>();
  let directoryOwnerRevision = $state(0);
  $effect(() => {
    const owner = serviceSession;
    const language = i18n.language;
    const picks = servicePicks;
    if (owner === directoryOwner && language === directoryLanguage && picks === directoryPicks)
      return;
    directoryOwner = owner;
    directoryLanguage = language;
    directoryPicks = picks;
    directoryOwnerRevision++;
    directoryLoads.clear();
    retryingDirectories = 0;
  });
  const directoryView = $derived.by(() => {
    const keys = [
      ...new Set(
        servicePicks.map(
          ({ country }) => `${directoryOwnerRevision}:${directoryKey(i18n.language, country)}`,
        ),
      ),
    ];
    const naming = keys.filter((key) => directoryLoads.get(key)?.status === 'loading').length;
    const failed = keys.filter((key) => {
      const status = directoryLoads.get(key)?.status;
      return status === 'partial' || status === 'failed';
    });
    const services = [...new Set(servicePicks.map((pick) => pick.country))].flatMap(
      (country) =>
        serviceResolver?.resolvePicks(
          servicePicks,
          directoryLoads.get(`${directoryOwnerRevision}:${directoryKey(i18n.language, country)}`)
            ?.services ?? [],
          country,
        ) ?? [],
    );
    const names = Object.fromEntries(
      services.flatMap(({ service }) =>
        [service.id, ...service.variants].map((id) => [id, service.name]),
      ),
    );
    return {
      naming,
      failed,
      services,
      names,
      settled:
        serviceDirectoriesAdmitted &&
        (directoryModuleFailed ||
          (!!directoryServices && naming === 0 && keys.every((key) => directoryLoads.has(key)))),
    };
  });
  function keepDirectoryLoad(key: string, load: ServiceDirectoryLoad) {
    directoryLoads.set(key, load);
  }
  function loadServiceDirectory(
    directory: typeof import('../settings/services'),
    owner: ProfileSession,
    language: InterfaceLanguage,
    country: string,
    key: string,
    refresh: boolean,
  ) {
    const request = ++directoryRequest;
    const revision = directoryOwnerRevision;
    const previous = directoryLoads.get(key);
    if (refresh) retryingDirectories++;
    keepDirectoryLoad(key, directory.beginServiceDirectoryLoad(previous, request));
    void directory
      .contentServicesResult(owner.content, country, refresh, language)
      .then(
        (result) => {
          const owned = directoryLoads.get(key);
          if (!owned || owned.request !== request) return;
          keepDirectoryLoad(key, directory.completeServiceDirectoryLoad(owned, request, result));
        },
        () => {
          const owned = directoryLoads.get(key);
          if (!owned || owned.request !== request) return;
          keepDirectoryLoad(key, directory.failServiceDirectoryLoad(owned, request));
        },
      )
      .finally(() => {
        if (refresh && directoryOwnerRevision === revision)
          retryingDirectories = Math.max(0, retryingDirectories - 1);
      });
  }
  $effect(() => {
    const directory = directoryServices;
    const owner = serviceSession;
    const language = i18n.language;
    if (!showServices || !serviceDirectoriesAdmitted || !directory || !owner) return;
    for (const country of new Set(servicePicks.map((pick) => pick.country))) {
      const key = `${directoryOwnerRevision}:${directoryKey(language, country)}`;
      if (directoryLoads.has(key)) continue;
      loadServiceDirectory(directory, owner, language, country, key, false);
    }
  });
  function retryServiceDirectories() {
    if (retryingDirectories || !directoryView.failed.length) return;
    const directory = directoryServices;
    const owner = serviceSession;
    if (!directory || !owner) return;
    const language = i18n.language;
    const failed = new Set(directoryView.failed);
    for (const country of new Set(servicePicks.map((pick) => pick.country))) {
      const key = `${directoryOwnerRevision}:${directoryKey(language, country)}`;
      if (failed.has(key)) loadServiceDirectory(directory, owner, language, country, key, true);
    }
  }
  $effect(() => {
    const owner = serviceSession;
    const publish = onServiceState;
    if (!showServices || !owner || !publish) return;
    publish({
      owner,
      language: i18n.language,
      picks: servicePicks,
      names: directoryView.names,
      settled: directoryView.settled,
    });
  });
</script>

{#if showServices}
  <ServicesRow
    services={directoryView.services}
    pending={serviceDirectoriesAdmitted
      ? (!directoryServices && !directoryModuleFailed) || directoryView.naming
        ? servicePicks.length
        : 0
      : servicePicks.length}
    empty={serviceDirectoriesAdmitted &&
    !directoryView.naming &&
    !directoryView.services.length &&
    (directoryModuleFailed || !directoryView.failed.length)
      ? 'Services unavailable'
      : undefined}
    failure={!directoryView.naming && directoryView.failed.length
      ? 'Services unavailable'
      : undefined}
    retrying={retryingDirectories > 0}
    onretry={retryServiceDirectories}
    onvisible={() => (serviceDirectoriesAdmitted = true)}
    onintent={onServiceIntent}
  />
{/if}
{#if browseReady}<Browse {rows} {shown} identity={browseIdentity} />{/if}
