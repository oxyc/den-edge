<!-- Home's below-the-fold catalogue is one lazy rendering tail: none of its row/credit code is parsed before the
     personal shelves, hero and first poster. Direct browse routes admit this component immediately. -->
<script lang="ts">
  import type { RowDef } from '../lib/catalog';
  import type { Title } from '../lib/library';
  import type { ProfileSession } from '../lib/profileSession.svelte';
  import type { ServicePick } from '../lib/prefs';
  import type { InterfaceLanguage } from '../lib/interfaceLanguage';
  import { resolvePicks } from '../lib/services';
  import { i18n } from '../lib/i18n.svelte';
  import { optionalImport } from '../lib/keyboardNavigation';
  import type { Service } from '../settings/services';
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
    serviceRows,
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
    serviceRows?: (names: Record<number, string>, settled: boolean) => RowDef[];
    onServiceIntent: (service: Service, country: string) => void;
  } = $props();

  /** Home's provider directory is part of this existing below-fold chunk, not Library's startup graph. */
  let directoryServices = $state.raw<
    typeof import('../settings/services') | null | false | undefined
  >(false);
  $effect(() => {
    if (!showServices || directoryServices !== undefined) return;
    let current = true;
    void optionalImport(import('../settings/services')).then(
      (directory) => {
        if (!current) return;
        directoryServices = directory;
      },
      () => {
        if (current) directoryServices = null;
      },
    );
    return () => {
      current = false;
    };
  });
  type DirectoryLoad = { services: Service[]; failed: boolean };
  let directoryLoads = $state.raw<Record<string, DirectoryLoad>>({});
  let directoryRetrying = $state(false);
  let directoryGeneration = 0;
  function setDirectory(run: number, country: string, load: DirectoryLoad) {
    if (run === directoryGeneration) directoryLoads = { ...directoryLoads, [country]: load };
  }
  function loadDirectory(
    directory: typeof import('../settings/services'),
    owner: ProfileSession,
    language: InterfaceLanguage,
    country: string,
    refresh: boolean,
    run: number,
  ) {
    const previous = directoryLoads[country]?.services ?? [];
    return directory.contentServicesResult(owner.content, country, refresh, language).then(
      (result) =>
        setDirectory(run, country, {
          services: result.complete
            ? result.services
            : directory.mergeServices(previous, result.services),
          failed: !result.complete,
        }),
      () => setDirectory(run, country, { services: previous, failed: true }),
    );
  }
  $effect(() => {
    const directory = directoryServices;
    const owner = serviceSession;
    const language = i18n.language;
    const picks = servicePicks;
    if (!showServices || !directory || !owner) return;
    const countries = [...new Set(picks.map((pick) => pick.country))];
    const run = ++directoryGeneration;
    directoryLoads = {};
    directoryRetrying = false;
    for (const country of countries)
      void loadDirectory(directory, owner, language, country, false, run);
    return () => {
      if (run === directoryGeneration) directoryGeneration++;
    };
  });
  function retryDirectories() {
    if (directoryRetrying) return;
    const directory = directoryServices;
    const owner = serviceSession;
    const failed = Object.entries(directoryLoads).filter(([, load]) => load.failed);
    if (!directory || !owner || !failed.length) return;
    const run = directoryGeneration;
    directoryRetrying = true;
    void Promise.all(
      failed.map(([country]) => loadDirectory(directory, owner, i18n.language, country, true, run)),
    ).finally(() => {
      if (run === directoryGeneration) directoryRetrying = false;
    });
  }
  const directoryView = $derived.by(() => {
    const countries = [...new Set(servicePicks.map((pick) => pick.country))];
    const naming = countries.length - Object.keys(directoryLoads).length;
    const services = countries.flatMap((country) => {
      const load = directoryLoads[country];
      return resolvePicks(servicePicks, load?.services ?? [], country);
    });
    const names = Object.fromEntries(
      services.flatMap(({ service }) =>
        [service.id, ...service.variants].map((id) => [id, service.name]),
      ),
    );
    return {
      naming,
      failed: Object.values(directoryLoads).some((load) => load.failed),
      services,
      names,
      settled: directoryServices === null || (!!directoryServices && naming === 0),
    };
  });
  const catalogueRows = $derived(serviceRows?.(directoryView.names, directoryView.settled) ?? rows);
</script>

{#if showServices}
  <ServicesRow
    services={directoryView.services}
    pending={directoryServices !== null && (!directoryServices || directoryView.naming)
      ? servicePicks.length
      : 0}
    empty={directoryServices !== false &&
    !directoryView.naming &&
    !directoryView.services.length &&
    (directoryServices === null || !directoryView.failed)
      ? 'Services unavailable'
      : undefined}
    recovery={directoryRetrying
      ? 'retrying'
      : !directoryView.naming && directoryView.failed
        ? 'failed'
        : undefined}
    onretry={retryDirectories}
    onvisible={() => (directoryServices = undefined)}
    onintent={onServiceIntent}
  />
{/if}
{#if browseReady}<Browse rows={catalogueRows} {shown} identity={browseIdentity} />{/if}
