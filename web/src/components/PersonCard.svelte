<!-- A person, round, as the TV's PersonCard: cast on a title's page, people in search and on People. A link to their
     page. -->
<script lang="ts">
  import { personHref } from '../lib/route';

  let {
    id,
    name,
    role,
    profilePath,
    knownFor = [],
    onopen,
    onvisible,
  }: {
    id: number;
    name: string;
    role?: string;
    profilePath?: string;
    /** Titles they are known for, named under their name. */
    knownFor?: string[];
    /** Called when this person's link is followed. */
    onopen?: () => void;
    /** Called once shortly before the card reaches the viewport. */
    onvisible?: (id: number) => void;
  } = $props();
  let card = $state<HTMLAnchorElement>();

  $effect(() => {
    const element = card;
    const reveal = onvisible;
    if (!element || !reveal) return;
    let sent = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (sent || !entries.some((entry) => entry.isIntersecting)) return;
        sent = true;
        reveal(id);
        observer.disconnect();
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  });
</script>

<a class="person" href={personHref(id)} onclick={onopen} bind:this={card}>
  <span class="portrait">
    {#if profilePath}
      <img
        src="https://image.tmdb.org/t/p/w185{profilePath}"
        alt=""
        loading="lazy"
        decoding="async"
      />
    {/if}
  </span>
  <span class="name">{name}</span>
  {#if role}<span class="role">{role}</span>{/if}
  {#if knownFor.length}<span class="known">{knownFor.join(', ')}</span>{/if}
</a>

<style>
  .person {
    display: grid;
    width: var(--card-w);
    color: inherit;
    font-size: 14px;
    text-align: center;
    text-decoration: none;
  }

  .portrait {
    display: block;
    aspect-ratio: 1;
    max-width: 100%;
    overflow: hidden;
    border-radius: 50%;
    background: var(--card);
  }

  .person:focus-visible .portrait {
    outline: 3px solid var(--accent);
    outline-offset: 3px;
  }

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .name {
    margin-top: 8px;
    font-weight: 600;
  }

  .role {
    overflow: hidden;
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Two lines at most: a grid of people stays a grid of faces. */
  .known {
    display: -webkit-box;
    overflow: hidden;
    color: var(--muted);
    font-size: 13px;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
</style>
