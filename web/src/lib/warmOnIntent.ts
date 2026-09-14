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

/** Call `warm` for the title a press is heading to. Returns the function that stops listening. */
export function warmOnIntent(warm: (ref: { type: MediaType; id: number }) => void): () => void {
  let last = '';
  const pressed = (event: Event) => {
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
    warm({ type: route.type, id: route.id });
  };
  // Capture, so a card that handles the press itself still warms. Passive, so this never delays it.
  document.addEventListener('pointerdown', pressed, { capture: true, passive: true });
  return () => document.removeEventListener('pointerdown', pressed, { capture: true });
}
