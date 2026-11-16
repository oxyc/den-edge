<script lang="ts">
  import type { ProfileSession } from '../src/lib/profileSession.svelte';
  import type { ServicePick } from '../src/lib/prefs';
  import { setInterfaceLanguage } from '../src/lib/i18n.svelte';
  import type { Service, ServiceDirectoryResult } from '../src/settings/services';
  import HomeCatalogue from '../src/components/HomeCatalogue.svelte';

  const result = new URL(location.href).searchParams.get('result') ?? 'unavailable';
  let requests = $state(0);
  const netflix: Service = {
    id: 8,
    name: 'Netflix',
    priority: 1,
    movies: true,
    series: true,
    variants: [],
  };
  const max: Service = {
    id: 1899,
    name: 'Max',
    priority: 2,
    movies: true,
    series: true,
    variants: [],
  };
  const serviceResolver = {
    resolvePicks(picks: readonly ServicePick[], directory: readonly Service[], country: string) {
      const here = picks.filter((pick) => pick.country === country);
      return directory.flatMap((service) => {
        const pick = here.find(({ id }) => service.id === id || service.variants.includes(id));
        return pick ? [{ pick, service }] : [];
      });
    },
  };
  let servicePicks = $state.raw<readonly ServicePick[]>([
    { id: netflix.id, country: 'US' },
    { id: max.id, country: 'US' },
  ]);
  if (result === 'replacement' || result === 'stale-owner')
    servicePicks = [{ id: netflix.id, country: 'US' }];
  if (result === 'staggered')
    servicePicks = [
      { id: netflix.id, country: 'US' },
      { id: max.id, country: 'FI' },
    ];

  let retryResolve: ((result: ServiceDirectoryResult) => void) | undefined;
  let staleRetryResolve: ((result: ServiceDirectoryResult) => void) | undefined;
  let outstandingResolve: ((result: ServiceDirectoryResult) => void) | undefined;
  let staleResolve: ((result: ServiceDirectoryResult) => void) | undefined;
  const held = (save: (resolve: (result: ServiceDirectoryResult) => void) => void) =>
    new Promise<ServiceDirectoryResult>((resolve) => save(resolve));

  function session(tag: string): ProfileSession {
    const content = {
      query: async (request: { kind: string; region?: string; interfaceLanguage?: string }) => {
        if (request.kind !== 'service.directory') throw new Error(`Unexpected ${request.kind}`);
        requests++;
        if (result === 'stale-owner') {
          if (tag === 'old' && !request.interfaceLanguage)
            return held((resolve) => (staleResolve = resolve));
          return {
            services: [
              {
                ...netflix,
                name: request.interfaceLanguage === 'sv' ? 'Netflix SV' : 'Netflix new',
              },
            ],
            complete: true,
          };
        }
        if (result === 'retry-owner') {
          if (tag === 'first') {
            if (requests === 1) throw new Error('unavailable');
            return held((resolve) => (staleRetryResolve = resolve));
          }
          return { services: [netflix, max], complete: true };
        }
        if (result === 'resolved' || result === 'replacement')
          return { services: [netflix, max], complete: true };
        if (result === 'duplicate') return { services: [netflix], complete: true };
        if (result === 'staggered') {
          if (request.region === 'FI') return held((resolve) => (outstandingResolve = resolve));
          if (requests === 1) return { services: [netflix], complete: false };
          return held((resolve) => (retryResolve = resolve));
        }
        if (result === 'partial' && requests === 1) return { services: [netflix], complete: false };
        if (requests === 1) throw new Error('unavailable');
        return held((resolve) => (retryResolve = resolve));
      },
    };
    return { content, fixtureTag: tag } as unknown as ProfileSession;
  }

  let serviceSession = $state.raw(session(result === 'stale-owner' ? 'old' : 'first'));
  let published = $state('none');
  function publish(state: {
    owner: ProfileSession;
    language: string;
    settled: boolean;
    names: Record<number, string>;
    picks: readonly ServicePick[];
  }) {
    const tag = (state.owner as unknown as { fixtureTag: string }).fixtureTag;
    published = `${tag}:${state.language}:${state.settled}:${state.names[netflix.id] ?? '-'}:${state.picks.length}`;
  }

  (window as unknown as { replaceServicesWithDuplicate: () => void }).replaceServicesWithDuplicate =
    () =>
      (servicePicks = [
        { id: netflix.id, country: 'US' },
        { id: netflix.id, country: 'FI' },
      ]);
  (window as unknown as { replaceServiceOwner: () => void }).replaceServiceOwner = () =>
    (serviceSession = session('new'));
  (window as unknown as { replaceServiceLanguage: () => Promise<void> }).replaceServiceLanguage =
    () => setInterfaceLanguage('sv');

  function resolveRetry() {
    retryResolve?.({ services: [netflix, max], complete: true });
    retryResolve = undefined;
  }
  function resolveOutstanding() {
    outstandingResolve?.({ services: [max], complete: true });
    outstandingResolve = undefined;
  }
  function resolveStale() {
    staleResolve?.({ services: [max], complete: true });
    staleResolve = undefined;
  }
  function resolveStaleRetry() {
    staleRetryResolve?.({ services: [max], complete: true });
    staleRetryResolve = undefined;
  }
</script>

<p data-requests>{requests}</p>
<p data-service-state>{published}</p>
<button data-resolve-retry hidden onclick={resolveRetry}>Resolve retry</button>
<button data-resolve-outstanding hidden onclick={resolveOutstanding}>Resolve outstanding</button>
<button data-resolve-stale hidden onclick={resolveStale}>Resolve stale</button>
<button data-resolve-stale-retry hidden onclick={resolveStaleRetry}>Resolve stale retry</button>
<div aria-hidden="true" style="height: 2400px"></div>
<HomeCatalogue
  rows={[]}
  shown={() => true}
  browseReady={false}
  browseIdentity="fixture"
  showServices
  {serviceSession}
  {servicePicks}
  {serviceResolver}
  onServiceState={publish}
  onServiceIntent={() => {}}
/>
