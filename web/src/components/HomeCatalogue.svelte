<!-- Home's below-the-fold catalogue is one lazy rendering tail: none of its row/credit code is parsed before the
     personal shelves, hero and first poster. Direct browse routes admit this component immediately. -->
<script lang="ts">
  import type { RowDef } from '../lib/catalog';
  import type { Title } from '../lib/library';
  import type { ProfileSession } from '../lib/profileSession.svelte';
  import type { ServicePick } from '../lib/prefs';
  import { i18n } from '../lib/i18n.svelte';
  import { optionalImport } from '../lib/keyboardNavigation';
  import type { Service, ServiceDirectoryResult } from '../settings/services';
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
    serviceResolver?: Pick<typeof import('../lib/services'), 'resolvePicks'> | null;
    serviceRows?: (names: Record<number, string>, settled: boolean) => RowDef[];
    onServiceIntent: (service: Service, country: string) => void;
  } = $props();

  /** Home's provider directory is part of this existing below-fold chunk, not Library's startup graph. */
  let directoryServices = $state.raw<
    typeof import('../settings/services') | null | false | undefined
  >(false);
  $effect(() => {
    if (directoryServices !== undefined) return;
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
  let directoryLoads = $state.raw<Record<string, ServiceDirectoryResult>>({});
  let directoryRetrying = $state(false);
  const retry = { current: () => {} };
  $effect(() => {
    const directory = directoryServices;
    const owner = serviceSession;
    const language = i18n.language;
    const picks = servicePicks;
    if (!directory || !owner) return;
    const countries = [...new Set(picks.map((pick) => pick.country))];
    let current = true;
    directoryLoads = {};
    directoryRetrying = false;
    const load = async (country: string, refresh: boolean, previous: Service[] = []) => {
      let result: ServiceDirectoryResult;
      try {
        result = await directory.contentServicesResult(owner.content, country, refresh, language);
      } catch {
        result = { services: previous, complete: false };
      }
      if (!current) return;
      directoryLoads = {
        ...directoryLoads,
        [country]: result.complete
          ? result
          : { services: directory.mergeServices(previous, result.services), complete: false },
      };
    };
    for (const country of countries) void load(country, false);
    retry.current = () => {
      if (directoryRetrying) return;
      const failed = Object.entries(directoryLoads).filter(([, result]) => !result.complete);
      if (!failed.length) return;
      directoryRetrying = true;
      void Promise.all(
        failed.map(([country, result]) => load(country, true, result.services)),
      ).finally(() => {
        if (current) directoryRetrying = false;
      });
    };
    return () => {
      current = false;
    };
  });
  const directoryView = $derived.by(() => {
    const countries = [...new Set(servicePicks.map((pick) => pick.country))];
    const naming =
      directoryServices === null ? 0 : countries.length - Object.keys(directoryLoads).length;
    const services = countries.flatMap((country) => {
      const load = directoryLoads[country];
      return serviceResolver?.resolvePicks(servicePicks, load?.services ?? [], country) ?? [];
    });
    const names = Object.fromEntries(
      services.flatMap(({ service }) =>
        [service.id, ...service.variants].map((id) => [id, service.name]),
      ),
    );
    return {
      naming,
      failed: Object.values(directoryLoads).some((load) => !load.complete),
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
    onretry={() => retry.current()}
    onvisible={() => (directoryServices = undefined)}
    onintent={onServiceIntent}
  />
{/if}
{#if browseReady}<Browse rows={catalogueRows} {shown} identity={browseIdentity} />{/if}
