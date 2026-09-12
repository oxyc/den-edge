import { describe, expect, it } from 'vitest';
import { blankEpisode, blankTitle, markEpisode, markWatched, unwatch } from './actions';
import { recordTrackerEvent, trackerEvent } from './trackerEvents';

describe('independent tracker event journal', () => {
  it('keeps seen and unseen in separate bounded rows', () => {
    const initial = blankTitle({ type: 'movie', id: 550 }, 1000);
    const seen = markWatched(initial, [2000, 0, 'web']);
    const first = recordTrackerEvent(initial, seen, [2000, 0, 'web'], 'seen')!;
    const second = recordTrackerEvent(seen, unwatch(seen, [3000, 0, 'tv']), [3000, 0, 'tv'], 'undo')!;
    expect(first.name).not.toBe(second.name);
    expect(trackerEvent(first)?.after).toEqual(seen);
    expect(trackerEvent(second)?.before).toEqual(seen);
    expect(JSON.stringify(second).length).toBeLessThan(4000);
  });
  it('retains episode undo progress and viewing', () => {
    const seen = markEpisode(blankEpisode({ type: 'tv', id: 1 }, 1, 2), true, [2000, 0, 'web']);
    const event = recordTrackerEvent(seen, markEpisode(seen, false, [3000, 0, 'web']), [3000, 0, 'web'], 'undo')!;
    expect(trackerEvent(event)?.changes.progress).toMatchObject({
      before: { value: 1, viewing: 0 }, after: { value: 0, viewing: 1 },
    });
  });
});
