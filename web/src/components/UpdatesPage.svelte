<!-- The profile's updates (den-spec follows-v1): what aired, returns or came out from what it follows. Derived on
     each device from public facts; only the read and dismissed marks are written. "Aired" and "Released" never say a
     source was found, so nothing here claims it can be played. -->
<script lang="ts">
  import Button from './Button.svelte';
  import Loading from './Loading.svelte';
  import PosterCard from './PosterCard.svelte';
  import { outDay } from '../lib/airing';
  import { i18n } from '../lib/i18n.svelte';
  import { titleHref } from '../lib/route';
  import type { ShownUpdate, UpdatesStore } from '../lib/updates.svelte';

  let {
    updates,
    onmark,
  }: {
    updates: UpdatesStore;
    onmark: (ids: string[], mark: 'read' | 'dismissed') => void | Promise<unknown>;
  } = $props();

  const events = $derived(updates.events);
  const unread = $derived(events.filter((event) => !event.read));
  const anyFollows = $derived(Object.keys(updates.follows).length > 0);

  function caption(event: ShownUpdate): string {
    const day = outDay(event.date, i18n.language);
    if (event.type === 'episode')
      return i18n.format('updates.episodeAired', 'S{season}E{episode} · aired {day}', {
        season: event.season ?? 0,
        episode: event.episode ?? 0,
        day,
      });
    if (event.type === 'returns')
      return event.season === 1
        ? i18n.format('updates.premieres', 'Premieres {day}', { day })
        : i18n.format('updates.returns', 'Season {season} returns {day}', {
            season: event.season ?? 0,
            day,
          });
    return i18n.format('updates.released', 'Released {day}', { day });
  }

  const href = (event: ShownUpdate) =>
    titleHref({
      ...event.card,
      ...(event.type === 'episode' ? { season: event.season, episode: event.episode } : {}),
    });
</script>

<section class="updates" aria-labelledby="updates-heading">
  <div class="heading">
    <h1 id="updates-heading">Updates</h1>
    {#if unread.length}
      <Button
        variant="secondary"
        size="compact"
        label="Mark all as read"
        onclick={() =>
          onmark(
            unread.map((event) => event.id),
            'read',
          )}
      />
    {/if}
  </div>
  {#if !anyFollows}
    <p class="note">Follow a title or person to see its updates here.</p>
  {:else if !events.length && updates.state === 'checking'}
    <Loading label="Checking for updates" />
  {:else if !events.length && updates.state === 'failed'}
    <p class="note">Couldn’t check for updates.</p>
    <Button
      variant="secondary"
      size="compact"
      label="Try again"
      onclick={() => updates.reconcile()}
    />
  {:else if !events.length}
    <p class="note">Nothing new yet.</p>
  {:else}
    <ul class="list">
      {#each events as event (event.id)}
        <li class:unread={!event.read} data-update={event.id}>
          <PosterCard
            title={event.card}
            href={href(event)}
            caption={caption(event)}
            badge={event.read ? undefined : i18n.phrase('New')}
            menu={false}
            checkAvailability={false}
            onopen={() => {
              if (!event.read) void onmark([event.id], 'read');
            }}
          />
          <div class="controls">
            {#if !event.read}
              <Button
                variant="tertiary"
                size="compact"
                label="Mark as read"
                onclick={() => onmark([event.id], 'read')}
              />
            {/if}
            <Button
              variant="tertiary"
              size="compact"
              label="Dismiss"
              onclick={() => onmark([event.id], 'dismissed')}
            />
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .updates {
    margin: 24px 0 40px;
  }

  .heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
    margin-bottom: 20px;
  }

  h1 {
    margin: 0;
    font-size: clamp(28px, 3.4vw, 44px);
  }

  .list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
    gap: 28px 24px;
    margin: 0;
    padding: 0;
    list-style: none;

    --card-w: 100%;
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }

  .note {
    color: var(--muted);
  }

  @media (width <= 759px) {
    .list {
      grid-template-columns: repeat(auto-fill, minmax(125px, 1fr));
      gap: 24px 16px;
    }
  }
</style>
