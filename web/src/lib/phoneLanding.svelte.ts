// What happens when a phone opens a "Use Den on your phone" link (`phoneLink.ts`): it joins the guest's library, then
// takes a slot in the guest's grant with the ticket in the link. The library comes first and does not depend on the
// slot: at the grant's device limit the phone still gets its library, without the host's addons, and says whom to ask.

import { guestGrants } from './grants.svelte';
import { links } from './links.svelte';
import type { PhoneLink } from './phoneLink';

const KEY = 'den.phoneLanding';

/** What became of the host's addons on this phone. */
export type AddonOutcome =
  /** The phone holds the grant. */
  | 'granted'
  /** The grant is at its device limit: ask the host to allow another. */
  | 'full'
  /** The link carried none: the laptop's grant had ended. */
  | 'none'
  /** The link's ticket lapsed or was used; the laptop makes a new link. */
  | 'expired';

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function kept(): PhoneLink | null {
  try {
    const value = JSON.parse(storage()?.getItem(KEY) ?? 'null') as Partial<PhoneLink> | null;
    if (
      typeof value?.libraryKey === 'string' &&
      (value.ticket === null || typeof value.ticket === 'string')
    )
      return { ticket: value.ticket ?? null, libraryKey: value.libraryKey };
  } catch {
    // Nothing readable is kept: no landing is under way.
  }
  return null;
}

export class PhoneLanding {
  /** The link this page opened, until it has been answered. Kept, so a reload resumes it. */
  request = $state<PhoneLink | null>(kept());
  phase = $state<'idle' | 'working' | 'done' | 'failed'>('idle');
  /** Why `phase` is `failed`. */
  problem = $state<string | null>(null);
  /** `kept`: this browser already held a synced library of its own, and keeps it. */
  library = $state<'joined' | 'kept' | null>(null);
  addons = $state<AddonOutcome | null>(null);
  /** Whose addons: the grant's host. Known once a ticket is spent or turned away as full. */
  host = $state('');

  begin(request: PhoneLink): void {
    this.request = request;
    this.phase = 'idle';
    try {
      storage()?.setItem(KEY, JSON.stringify(request));
    } catch {
      // Held for this visit only.
    }
  }

  /** Try again after a failure. */
  retry(): void {
    if (this.phase === 'failed') this.phase = 'idle';
  }

  /** The viewer has read the answer. */
  dismiss(): void {
    this.request = null;
    this.phase = 'idle';
    try {
      storage()?.removeItem(KEY);
    } catch {
      // The next visit finds it and says its answer again, which is harmless.
    }
  }

  /**
   * Carry the link out. `move` is the library authority's merge of this browser's own library into the one a key
   * opens, and is null for a browser that already holds a synced library. Each step is done once however often a
   * failed attempt is retried.
   */
  async run(
    move: ((libraryKey: string) => Promise<boolean>) | null,
    fetchImpl: typeof fetch = fetch,
  ): Promise<void> {
    const request = this.request;
    if (!request || this.phase === 'working' || this.phase === 'done') return;
    this.phase = 'working';
    this.problem = null;
    if (!this.library) {
      const held = links.current;
      if (held) {
        this.library = held.libraryKey === request.libraryKey ? 'joined' : 'kept';
      } else {
        if (!move || !(await move(request.libraryKey))) {
          this.fail(
            'Couldn’t bring your library to this phone. Check your connection and try again.',
          );
          return;
        }
        links.addRecovered(request.libraryKey, { name: 'your library', guest: true });
        this.library = 'joined';
      }
    }
    if (!request.ticket) {
      this.addons = 'none';
    } else {
      const result = await guestGrants.redeemTicket(request.ticket, fetchImpl);
      if (!('failure' in result)) {
        this.addons = 'granted';
        this.host = result.name;
      } else if (result.failure === 'full') {
        this.addons = 'full';
        this.host = result.host;
      } else if (result.failure === 'invalid') {
        this.addons = 'expired';
      } else {
        this.fail(
          result.failure === 'throttled'
            ? 'Too many tries. Wait a minute and try again.'
            : 'Couldn’t reach Den. Check your connection and try again.',
        );
        return;
      }
    }
    this.phase = 'done';
    try {
      storage()?.removeItem(KEY);
    } catch {
      // See `dismiss`.
    }
  }

  private fail(problem: string): void {
    this.problem = problem;
    this.phase = 'failed';
  }
}

export const phoneLanding = new PhoneLanding();
