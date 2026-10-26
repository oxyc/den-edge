import { describe, expect, it } from 'vitest';
import { HistoryDetailRequests } from './historyDetailRequests';
import { LIBRARY_SERVICE_WIRE_LIMITS, type TitleRef } from './libraryServiceProtocol';

const tv = (id: number): TitleRef => ({ type: 'tv', id });

class TrackedMap extends Map<string, unknown> {
  sizeReads = 0;

  override get size(): number {
    this.sizeReads++;
    return super.size;
  }
}

describe('HistoryDetailRequests', () => {
  it('deduplicates and bounds one visible-card request', () => {
    const requests = new HistoryDetailRequests();
    const titles = [
      { type: 'movie', id: 1 } as const,
      ...Array.from({ length: LIBRARY_SERVICE_WIRE_LIMITS.historyDetailTitles + 5 }, (_, index) =>
        tv(index + 1),
      ),
      tv(1),
    ];
    const first = requests.take(titles, new Map());
    expect(first).toHaveLength(LIBRARY_SERVICE_WIRE_LIMITS.historyDetailTitles);
    expect(requests.take(titles, new Map())).toEqual([]);
    requests.settled();
    const loaded = new Map(first.map((title) => [`tv:${title.id}`, []]));
    expect(requests.take(titles, loaded).map((title) => title.id)).toEqual([49, 50, 51, 52, 53]);
  });

  it('latches failures until a replacement History snapshot resets them', () => {
    const requests = new HistoryDetailRequests();
    const title = tv(9);
    expect(requests.take([title], new Map())).toEqual([title]);
    requests.settled([title]);
    expect(requests.take([title], new Map())).toEqual([]);
    requests.reset();
    expect(requests.take([title], new Map())).toEqual([title]);
  });

  it('does not ask again for loaded or successfully pending titles', () => {
    const requests = new HistoryDetailRequests();
    const title = tv(9);
    expect(requests.take([title], new Map())).toEqual([title]);
    requests.settled();
    expect(requests.take([title], new Map([['tv:9', []]]))).toEqual([]);
  });

  it('keeps the reactive loaded-state dependency while a batch is pending', () => {
    const requests = new HistoryDetailRequests();
    const loaded = new TrackedMap();
    expect(requests.take([tv(1), tv(2)], loaded)).toEqual([tv(1), tv(2)]);
    expect(loaded.sizeReads).toBe(1);

    // This represents a render effect rerun before the Worker reply. It must still read SvelteMap.size so storing
    // that reply invalidates the effect and allows the next batch to drain.
    expect(requests.take([tv(1), tv(2)], loaded)).toEqual([]);
    expect(loaded.sizeReads).toBe(2);
  });
});
