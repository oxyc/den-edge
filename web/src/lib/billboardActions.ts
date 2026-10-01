/** The library actions a billboard slide offers. */
export type SlideAction = 'watchlist' | 'seen';

/**
 * Whether pressing `action` — turning it `on`, or off — is the viewer done with the slide, so the billboard moves
 * on and leaves the title out for the rest of the visit.
 *
 * Home's billboard offers what the library doesn't hold yet: saving a title or marking it seen is done with it.
 * The Watchlist page's billboard IS the watchlist, so there taking a title off it is too. Undoing anything else —
 * unseen, or off the watchlist on Home — leaves the slide where it is.
 */
export function leavesBillboard(action: SlideAction, on: boolean, watchlistPage: boolean): boolean {
  if (action === 'seen') return on;
  return watchlistPage ? !on : on;
}

/** The slide after `at` of `count`, as the auto-advance takes it: the next one, and the first after the last. */
export function nextSlide(at: number, count: number): number {
  return at + 1 < count ? at + 1 : 0;
}
