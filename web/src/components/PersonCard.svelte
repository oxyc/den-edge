<!-- A person, round, as the TV's PersonCard: cast on a title's page, people in search. A link to their page. -->
<script lang="ts">
  import { personHref } from '../lib/route';

  let {
    id,
    name,
    role,
    profilePath,
  }: { id: number; name: string; role?: string; profilePath?: string } = $props();
</script>

<a class="person" href={personHref(id)}>
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
</style>
