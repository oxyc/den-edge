<!-- Where each section of the page is, following the one in view: a rail beside the page on a wide screen, a bar of
     tabs on a tablet, and the browser's own picker on a phone, where five tabs don't fit. -->
<script lang="ts">
  const SECTIONS = [
    { id: 'connections', label: 'Connections' },
    { id: 'sharing', label: 'Sharing' },
    { id: 'assistants', label: 'Assistants' },
    { id: 'playback', label: 'Playback' },
    { id: 'content', label: 'Content' },
    { id: 'advanced', label: 'Advanced' },
    { id: 'about', label: 'About' },
  ] as const;

  let { variant }: { variant: 'rail' | 'bar' } = $props();
  let current = $state<string>(SECTIONS[0].id);

  $effect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) current = visible.target.id;
      },
      { rootMargin: '-120px 0px -60% 0px' },
    );
    for (const section of SECTIONS) {
      const element = document.getElementById(section.id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  });

  function go(id: string) {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(id)?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
    // The history entry keeps the router's state; only its fragment names the section, so the address can be shared.
    history.replaceState(history.state, '', `#${id}`);
    current = id;
  }
</script>

{#if variant === 'rail'}
  <nav class="rail" aria-label="Settings sections">
    {#each SECTIONS as section (section.id)}
      <a
        href="#{section.id}"
        aria-current={current === section.id ? 'true' : undefined}
        onclick={(event) => {
          event.preventDefault();
          go(section.id);
        }}>{section.label}</a
      >
    {/each}
  </nav>
{:else}
  <nav class="tabs glass" aria-label="Settings sections">
    {#each SECTIONS as section (section.id)}
      <a
        href="#{section.id}"
        aria-current={current === section.id ? 'true' : undefined}
        onclick={(event) => {
          event.preventDefault();
          go(section.id);
        }}>{section.label}</a
      >
    {/each}
  </nav>
  <div class="jump glass">
    <select aria-label="Go to section" value={current} onchange={(e) => go(e.currentTarget.value)}>
      {#each SECTIONS as section (section.id)}
        <option value={section.id}>{section.label}</option>
      {/each}
    </select>
  </div>
{/if}

<style>
  .rail {
    position: sticky;
    top: calc(var(--bar-space) + 8px);
    display: grid;
    align-self: start;
    gap: 2px;
    padding-top: 58px;
  }

  a:focus-visible {
    outline: 2px solid var(--accent);
  }

  .rail a {
    padding: 8px 12px;
    border-radius: 10px;
    color: var(--muted);
    font-weight: 600;
    text-decoration: none;
  }

  .tabs a {
    padding: 6px 14px;
    border-radius: 999px;
    color: var(--muted);
    font-size: 15px;
    font-weight: 600;
    text-decoration: none;
    white-space: nowrap;
  }

  .rail a:hover {
    background: rgb(255 255 255 / 0.05);
    color: var(--fg);
  }

  .rail a[aria-current] {
    background: rgb(255 255 255 / 0.09);
    color: var(--fg);
  }

  .tabs,
  .jump {
    position: sticky;
    z-index: 10;
    top: calc(var(--bar-space) - 6px);
    display: none;
    width: max-content;
    max-width: 100%;
    margin: 0 0 20px;
    border-radius: 999px;
  }

  .tabs {
    gap: 2px;
    padding: 4px;
  }

  .tabs a[aria-current] {
    background: rgb(255 255 255 / 0.14);
    color: var(--fg);
  }

  .jump select {
    min-height: 44px;
    padding: 0 40px 0 18px;
    border: 0;
    border-radius: 999px;
    appearance: none;
    background: transparent
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23e7e7ea' stroke-width='2.2' stroke-linecap='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")
      no-repeat right 14px center / 14px;
    color: var(--fg);
    font: inherit;
    font-weight: 600;
  }

  .jump option {
    background: var(--card);
  }

  .jump select:focus-visible {
    outline: 2px solid var(--accent);
  }

  @media (760px <= width < 1100px) {
    .tabs {
      display: flex;
    }
  }

  @media (width < 760px) {
    .jump {
      display: block;
    }
  }
</style>
