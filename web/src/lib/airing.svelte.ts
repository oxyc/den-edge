import { SvelteMap } from 'svelte/reactivity';
import type { Airing, AiringSeries } from './airing';
import type { ContentServiceClientPort } from './contentServiceClient';
import { CONTENT_SERVICE_WIRE_LIMITS } from './contentServiceProtocol';

/**
 * The page's release dates for the series its viewer follows, as the content worker last answered them (`atlas.airing`).
 * Home asks for every followed series and a title page for its own; both read the same answers, so an episode card,
 * the billboard and Continue Watching never disagree about a date.
 */
export class AiringStore {
  readonly #airings = new SvelteMap<number, Airing>();
  constructor(private readonly content: ContentServiceClientPort) {}

  get(series: number): Airing | undefined {
    return this.#airings.get(series);
  }

  get all(): ReadonlyMap<number, Airing> {
    return this.#airings;
  }

  /**
   * Ask for `series`' dates. The worker asks atlas only for those it does not hold fresh; a failure changes nothing.
   * Asked a request's worth at a time: one past the wire's title limit is refused whole, which left a library following
   * more series than that with no dates at all.
   */
  async follow(series: readonly AiringSeries[]): Promise<void> {
    for (let at = 0; at < series.length; at += CONTENT_SERVICE_WIRE_LIMITS.titles) {
      const answer = await this.content
        .query({
          kind: 'atlas.airing',
          series: series.slice(at, at + CONTENT_SERVICE_WIRE_LIMITS.titles),
        })
        .catch(() => null);
      if (answer?.airing.state !== 'ready') continue;
      for (const { tmdb, airing } of answer.airing.value) {
        const held = this.#airings.get(tmdb);
        if (!held || JSON.stringify(held) !== JSON.stringify(airing))
          this.#airings.set(tmdb, airing);
      }
    }
  }
}

const stores = new WeakMap<ContentServiceClientPort, AiringStore>();

/** The one store for a session's content service. */
export function airingStore(content: ContentServiceClientPort): AiringStore {
  let store = stores.get(content);
  if (!store) {
    store = new AiringStore(content);
    stores.set(content, store);
  }
  return store;
}
