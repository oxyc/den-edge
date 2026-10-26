<!-- Home's below-the-fold catalogue is one lazy rendering tail: none of its row/credit code is parsed before the
     personal shelves, hero and first poster. Direct browse routes admit this component immediately. -->
<script lang="ts">
  import type { RowDef } from '../lib/catalog';
  import type { Title } from '../lib/library';
  import type { ResolvedService } from '../lib/services';
  import type { Service } from '../settings/services';
  import Browse from './Browse.svelte';
  import ServicesRow from './ServicesRow.svelte';

  let {
    rows,
    shown,
    browseReady,
    showServices,
    services,
    servicePending,
    serviceEmpty,
    onServiceVisible,
    onServiceIntent,
  }: {
    rows: RowDef[];
    shown: (title: Title) => boolean;
    /** Home waits for its visible provider names so catalogue rows load once with their final captions. */
    browseReady: boolean;
    showServices: boolean;
    services: ResolvedService[];
    servicePending: number;
    serviceEmpty?: string;
    onServiceVisible: () => void;
    onServiceIntent: (service: Service, country: string) => void;
  } = $props();
</script>

{#if showServices}
  <ServicesRow
    {services}
    pending={servicePending}
    empty={serviceEmpty}
    onvisible={onServiceVisible}
    onintent={onServiceIntent}
  />
{/if}
{#if browseReady}<Browse {rows} {shown} />{/if}
