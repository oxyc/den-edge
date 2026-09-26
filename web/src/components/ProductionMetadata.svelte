<script lang="ts">
  import type { TitleDetail } from '../lib/detail';
  import type { IconicStudio } from '../lib/iconicStudios';
  import { searchHref } from '../lib/route';

  let {
    detail: d,
    studios = [],
    class: className = '',
  }: {
    detail: TitleDetail;
    studios?: IconicStudio[];
    class?: string;
  } = $props();

  const money = (n: number) =>
    '$' + new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  const financial = $derived(
    d.revenue && d.revenue > 0
      ? `${money(d.revenue)} box office`
      : d.budget && d.budget > 0
        ? `${money(d.budget)} budget`
        : '',
  );
  const shownStudios = $derived(studios.slice(0, 2));
  interface MetadataItem {
    id: string | number;
    name: string;
    href?: string;
  }
  const groups = $derived.by((): MetadataItem[][] =>
    [
      d.languages.slice(0, 3).map((item) => ({
        ...item,
        href: searchHref('', { chips: [`lang-${item.id}`] }),
      })),
      d.countries.slice(0, 2).map((item) => ({
        ...item,
        href: searchHref('', { chips: [`country-${item.id}`] }),
      })),
      financial ? [{ id: 'financial', name: financial }] : [],
      shownStudios.length
        ? shownStudios.map((item) => ({
            ...item,
            href: searchHref('', { chips: [`studio-${item.id}`] }),
          }))
        : d.studios.slice(0, 2).map((name) => ({ id: name, name })),
    ].filter((group) => group.length),
  );
  const hasFacts = $derived(
    d.languages.length ||
      d.countries.length ||
      financial ||
      shownStudios.length ||
      d.studios.length,
  );
</script>

{#if hasFacts}
  <p class={`production ${className}`.trim()}>
    {#each groups as group, groupIndex (group.map((item) => item.id).join(':'))}
      {#if groupIndex}<span class="separator" aria-hidden="true"> · </span>{/if}
      {#each group as item, itemIndex (item.id)}
        {#if itemIndex}<span aria-hidden="true">, </span>{/if}
        {#if item.href}<a href={item.href}>{item.name}</a>{:else}<span>{item.name}</span>{/if}
      {/each}
    {/each}
  </p>
{/if}

<style>
  .production {
    color: var(--muted);
    font-size: 14px;
    margin: 20px 0 0;
  }

  a {
    color: inherit;
    text-decoration-color: transparent;
    text-underline-offset: 3px;
  }

  a:hover,
  a:focus-visible {
    color: var(--fg);
    text-decoration-color: currentcolor;
  }
</style>
