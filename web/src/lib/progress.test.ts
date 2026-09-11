import { describe, expect, it } from 'vitest';
import { blankEpisode, blankTitle, markWatched, updateEpisodeProgress, updateProgress } from './actions';
import type { Stamp } from './wire';

const at = (t: number): Stamp => [t, 0, 'web1'];
const ref = { type: 'movie' as const, id: 1 };

describe('updateProgress', () => {
  it('puts a movie in progress, and seen past the credits', () => {
    const playing = updateProgress(blankTitle(ref, 0), 0.4, 2880, at(1000));
    expect([playing.status.value, playing.resume]).toEqual(['inProgress', { value: 0.4, at: at(1000), viewing: 0, seconds: 2880 }]);
    const done = updateProgress(playing, 0.97, 6984, at(2000));
    expect([done.status.value, done.watchedAt]).toEqual(['watched', 2000]);
  });

  it('starts a new viewing when a finished movie is played again', () => {
    const replay = updateProgress(markWatched(blankTitle(ref, 0), at(1000)), 0.1, 720, at(2000));
    expect([replay.status.value, replay.resume.value, replay.resume.viewing]).toEqual(['inProgress', 0.1, 1]);
  });

  it('moves an episode, with the same replay rule', () => {
    const episode = updateEpisodeProgress(blankEpisode({ type: 'tv', id: 2 }, 1, 3), 0.5, 1500, at(1000));
    expect(episode.progress).toEqual({ value: 0.5, at: at(1000), viewing: 0, seconds: 1500 });
    const seen = updateEpisodeProgress(episode, 1, 3000, at(2000));
    expect(updateEpisodeProgress(seen, 0.2, 600, at(3000)).progress.viewing).toBe(1);
  });
});
