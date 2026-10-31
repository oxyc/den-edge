import { SvelteMap } from 'svelte/reactivity';
import type { Airing, AiringSeries } from './airing';
import type { ContentServiceClientPort } from './contentServiceClient';

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

  /** Ask for `series`' dates. The worker asks atlas only for those it does not hold fresh; a failure changes nothing. */
  async follow(series: readonly AiringSeries[]): Promise<void> {
    if (!series.length) return;
    const answer = await this.content
      .query({ kind: 'atlas.airing', series: [...series] })
      .catch(() => null);
    if (answer?.airing.state !== 'ready') return;
    for (const { tmdb, airing } of answer.airing.value) {
      const held = this.#airings.get(tmdb);
      if (!held || JSON.stringify(held) !== JSON.stringify(airing)) this.#airings.set(tmdb, airing);
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
