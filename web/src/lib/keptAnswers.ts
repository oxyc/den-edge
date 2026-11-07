// Whether this realm is showing answers kept on this device in place of the ones den-edge could not give (the box or
// its uplink down). The content Worker tells its page (`ContentServiceStatusValue` `kept`), which says so, so a page
// drawn from an earlier copy never reads as a live one, nor its gaps as a broken app. Any answer from the network
// afterwards means den-edge is back, whichever provider it was for.

import type { ContentProvider } from './contentServiceProtocol';

type Listener = (provider: ContentProvider, kept: boolean) => void;

const listeners = new Set<Listener>();
/** The provider a kept answer last stood in for, while no provider has answered since. */
let showing: ContentProvider | null = null;

/**
 * Hear each change: `kept` true once a kept answer stands in, false once a provider answers again. A listener that
 * arrives while one stands in (a second tab on a shared Worker) hears that at once.
 */
export function onKeptAnswers(listener: Listener): () => void {
  listeners.add(listener);
  if (showing) listener(showing, true);
  return () => listeners.delete(listener);
}

/** A kept answer was handed out because `provider` could not be reached. */
export function keptAnswerServed(provider: ContentProvider): void {
  if (showing) return;
  showing = provider;
  for (const listener of listeners) listener(provider, true);
}

/** `provider` answered from the network. */
export function providerAnswered(provider: ContentProvider): void {
  if (!showing) return;
  showing = null;
  for (const listener of listeners) listener(provider, false);
}
