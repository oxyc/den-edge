// Starting a title's trailer when the pointer goes down, rather than when the click lands — InstantClick's
// trick, one listener at the document.
//
// Resolving a trailer is a couple of seconds of yt-dlp, and it used to begin only once the detail page had
// mounted and asked for it, so the whole wait was serial and visible. Pressing a card is intent enough: the
// gap between pointerdown and click is around 100ms with a mouse and 150-300ms on touch, and that is time the
// resolve can already be running in.
//
// One delegated listener rather than a callback threaded through every row and card: it reads the link's own
// href, so it covers every link to a title there is — the rows, search results, a person's filmography, the
// billboard, and anything added later — without any of them knowing about it.

import type { MediaType } from './library';
import { parseRoute } from './route';

type Warm = (ref: { type: MediaType; id: number }) => void;

/**
 * The one callback the document's single listener calls, and what the last press warmed.
 *
 * Both are module state on purpose. `Library` is rendered inside the router's per-route snippet and the
 * router keeps several routes mounted for back-navigation, so this was being registered once per instance —
 * three listeners, each holding its OWN idea of the last title pressed, so none of them ever de-duplicated
 * the others. Measured from a phone: one press produced three `/meta` lookups within 16 ms of each other and
 * three `/sources` asks, so reel resolved the same trailer three times and fetched Google three times over.
 *
 * Every instance closes over the same library and routes, so the newest registration is as good as any; the
 * extra listeners were pure waste rather than a disagreement.
 */
let warmer: Warm | null = null;
let last = '';

function pressed(event: Event) {
  const target = event.target as Element | null;
  const href = target?.closest?.('a[href]')?.getAttribute('href');
  if (!href) return;
  const route = parseRoute(href);
  if (route.page !== 'title') return;
  // The same card pressed twice in a row is one warm-up: a second press while the first is still resolving
  // tells reel nothing it isn't already doing.
  const key = `${route.type}:${route.id}`;
  if (key === last) return;
  last = key;
  warmer?.({ type: route.type, id: route.id });
}

/** Forget it. The listener and the last-pressed title outlive any one caller, so a test must reset them. */
export function forgetWarmOnIntent(): void {
  warmer = null;
  last = '';
}

/**
 * Call `warm` for the title a press is heading to. Returns the function that stops listening.
 *
 * `on` is the document in an app and a stand-in in a test, the same way `nativeHls` takes its environment:
 * what this needs to get right is how many listeners it registers, and that cannot be checked at all from
 * a test runner with no DOM.
 */
export function warmOnIntent(warm: Warm, on: EventTarget = document): () => void {
  const listening = warmer !== null;
  warmer = warm;
  // Capture, so a card that handles the press itself still warms. Passive, so this never delays it.
  if (!listening) on.addEventListener('pointerdown', pressed, { capture: true, passive: true });
  return () => {
    // Only the registration still in force tears down: an instance the router has dropped must not remove
    // the listener a live one is relying on.
    if (warmer !== warm) return;
    warmer = null;
    last = '';
    on.removeEventListener('pointerdown', pressed, { capture: true });
  };
}
