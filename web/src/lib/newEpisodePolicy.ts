import { ensureSyncPolicy } from './syncLoader';
import { syncPolicy } from './syncCore';
import type { ContentNewEpisodes, ContentNewEpisodesRequest } from './contentServiceProtocol';

/**
 * Thin Edge binding to den-core's `new_episodes`, the one new-episode rule every client shares: who is followed, which
 * episode is new to the viewer and what is coming up. It holds no rule of its own.
 */
export async function newEpisodes(request: ContentNewEpisodesRequest): Promise<ContentNewEpisodes> {
  await ensureSyncPolicy();
  const answer = syncPolicy<
    Omit<ContentNewEpisodes, 'comingUp'> & { coming_up: ContentNewEpisodes['comingUp'] }
  >({
    op: 'new_episodes',
    today: request.today,
    watchlist: request.watchlist,
    continuing: request.continuing,
    caught_up: request.caughtUp,
    seen: request.seen,
    dismissed: request.dismissed,
    airing: request.airing,
  });
  return {
    candidates: answer.candidates,
    followed: answer.followed,
    released: answer.released,
    new: answer.new,
    comingUp: answer.coming_up,
  };
}
