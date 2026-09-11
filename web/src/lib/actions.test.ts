import { describe, expect, it } from 'vitest';
import {
  addToWatchlist,
  blankEpisode,
  blankTitle,
  markEpisode,
  markWatched,
  react,
  removeFromLibrary,
  unwatch,
} from './actions';
import { mergeEpisode, mergeTitle, type Stamp } from './wire';

const at = (t: number, device = 'web1'): Stamp => [t, 0, device];
const dune = blankTitle({ type: 'movie', id: 693134 }, 1000);

describe('actions, as the TV does them', () => {
  it('adds to the watchlist, and a title in progress stays in progress', () => {
    const listed = addToWatchlist(dune, at(2000));
    expect([listed.status.value, listed.deleted.value]).toEqual(['watchlist', false]);
    const playing = { ...dune, status: { value: 'inProgress' as const, at: at(1500) } };
    expect(addToWatchlist(playing, at(2000)).status.value).toBe('inProgress');
  });

  it('removes with a tombstone that a later add undoes', () => {
    const removed = removeFromLibrary(addToWatchlist(dune, at(2000)), at(3000));
    expect(removed.deleted).toEqual({ value: true, at: at(3000) });
    expect(addToWatchlist(removed, at(4000)).deleted.value).toBe(false);
  });

  it('marks seen, and un-seeing starts a new viewing that beats the TV’s finished one', () => {
    const watched = markWatched(dune, at(2000, 'tv01'));
    expect([watched.status.value, watched.resume.value, watched.watchedAt]).toEqual(['watched', 1, 2000]);
    const unseen = unwatch(watched, at(3000));
    expect([unseen.status.value, unseen.resume.value, unseen.resume.viewing]).toEqual(['none', 0, 1]);
    const merged = mergeTitle(watched, unseen);
    expect([merged.status.value, merged.resume.value]).toEqual(['none', 0]);
  });

  it('sets and clears the opinion', () => {
    const loved = react(dune, 'love', at(2000));
    expect(loved.reaction).toEqual({ value: 'love', at: at(2000) });
    expect(react(loved, null, at(3000)).reaction.value).toBeNull();
  });

  it('marks an episode seen, and un-seeing it starts a new viewing that beats the seen one', () => {
    const episode = blankEpisode({ type: 'tv', id: 95396 }, 1, 2);
    const seen = markEpisode(episode, true, at(2000, 'tv01'));
    expect([seen.progress.value, seen.progress.viewing]).toEqual([1, 0]);
    const unseen = markEpisode(seen, false, at(3000));
    expect([unseen.progress.value, unseen.progress.viewing]).toEqual([0, 1]);
    expect(mergeEpisode(seen, unseen).progress.value).toBe(0);
    expect(markEpisode(unseen, true, at(4000)).progress).toEqual({ value: 1, at: at(4000), viewing: 1 });
  });
});
