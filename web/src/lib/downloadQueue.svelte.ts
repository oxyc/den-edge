import { SvelteMap } from 'svelte/reactivity';
import { prepareSource, type Preparation, type TitleSource } from './titleSources';

/** Page-independent jobs: navigation must never turn a status poll into another download request. */
export class DownloadQueue {
  readonly states = new SvelteMap<string, Preparation>();
  private pending = new Map<string, Promise<Preparation>>();
  constructor(private readonly prepare = prepareSource) {}

  async start(key: string, source: TitleSource): Promise<Preparation> {
    const pending = this.pending.get(key);
    if (pending) return pending;
    const previous = this.states.get(key);
    if (previous && previous.state !== 'not-queued' && previous.state !== 'failed') return previous;
    if (source.cached === true) {
      const ready: Preparation = { state: 'ready' }; this.states.set(key, ready); return ready;
    }
    // Even an uncertain response may mean the service accepted the request. Only probe after it.
    const request = this.prepare(source.url, true).then((state) => {
      this.states.set(key, state); this.pending.delete(key); this.trim(); return state;
    });
    this.pending.set(key, request); this.states.set(key, { state: 'unknown', message: 'Starting download…' });
    return request;
  }

  async poll(key: string, source: TitleSource): Promise<Preparation> {
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = this.prepare(source.url, false).then((state) => {
      this.states.set(key, state); this.pending.delete(key); return state;
    });
    this.pending.set(key, request); return request;
  }

  private trim() {
    if (this.states.size <= 100) return;
    for (const [key, state] of this.states) {
      if (!this.pending.has(key) && ['ready', 'failed', 'not-queued'].includes(state.state)) this.states.delete(key);
      if (this.states.size <= 100) break;
    }
  }
}
export const downloads = new DownloadQueue();
