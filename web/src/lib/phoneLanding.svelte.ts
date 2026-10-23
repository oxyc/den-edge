// What happens when a phone opens a "Use Den on your phone" link (`phoneLink.ts`): it runs the pairing the link names
// (`pair.ts` `join`), which the guest's laptop must allow, and receives the library key sealed; then it takes a slot in
// the guest's grant with the ticket in the link. The library comes first and does not depend on the slot: at the
// grant's device limit the phone still gets its library, without the host's addons, and says whom to ask.

import { guestGrants } from './grants.svelte';
import { links } from './links.svelte';
// Type-only: this module is read at startup, and `pair.ts` brings @noble/curves; `run` loads it (`pairJoin.ts`) to join.
import type { join as pairJoin, JoinError } from './pair';
import type { PhoneLink } from './phoneLink';
import { thisDevice } from './device.svelte';

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
      typeof value?.code === 'string' &&
      (value.ticket === null || typeof value.ticket === 'string')
    )
      return { ticket: value.ticket ?? null, code: value.code };
  } catch {
    // Nothing readable is kept: no landing is under way.
  }
  return null;
}

/** What a pairing that cannot be tried again says, and what one that can says. */
const JOIN_PROBLEMS: Record<JoinError, { text: string; final: boolean }> = {
  expired: { text: 'This link has expired. Make a new one on your laptop.', final: true },
  claimed: {
    text: 'This link was already used. Make a new one on your laptop.',
    final: true,
  },
  mistyped: { text: 'That isn’t a whole link. Make a new one on your laptop.', final: true },
  failed: {
    text: 'Your laptop didn’t allow this phone, or didn’t answer in time. Make a new link on it.',
    final: true,
  },
  throttled: { text: 'Too many tries. Wait a minute and try again.', final: false },
  unreachable: { text: 'Couldn’t reach Den. Check your connection and try again.', final: false },
  insecure: {
    text: 'This needs a secure connection. Open the link over https and try again.',
    final: true,
  },
};

export type Joiner = typeof pairJoin;

export class PhoneLanding {
  /** The link this page opened, until it has been answered. Kept, so a reload shows its answer. */
  request = $state.raw<PhoneLink | null>(kept());
  phase = $state<'idle' | 'working' | 'done' | 'failed'>('idle');
  /** Why `phase` is `failed`, and whether another try can help. */
  problem = $state<string | null>(null);
  retryable = $state(false);
  /** `kept`: this browser already held a synced library of its own, and keeps it. */
  library = $state<'joined' | 'kept' | null>(null);
  addons = $state<AddonOutcome | null>(null);
  /** Whose addons: the grant's host. Known once a ticket is spent or turned away as full. */
  host = $state('');
  /** The library key the laptop handed over, until this browser holds it. Memory only. */
  private key: string | null = null;

  begin(request: PhoneLink): void {
    this.request = request;
    this.phase = 'idle';
    try {
      storage()?.setItem(KEY, JSON.stringify(request));
    } catch {
      // Held for this visit only.
    }
  }

  /** Try again after a failure that another try can help. */
  retry(): void {
    if (this.phase === 'failed' && this.retryable) this.phase = 'idle';
  }

  /** The viewer has read the answer. */
  dismiss(): void {
    this.request = null;
    this.phase = 'idle';
    this.key = null;
    this.forget();
  }

  private forget(): void {
    try {
      storage()?.removeItem(KEY);
    } catch {
      // The next visit finds it and says its answer again, which is harmless.
    }
  }

  /**
   * Carry the link out. `move` is the library authority's merge of this browser's own library into the one a key
   * opens, and is null for a browser that already holds a synced library. A browser that does asks its laptop for
   * nothing: it keeps its library, and only the ticket is spent. Each step is done once however often a failed
   * attempt is retried.
   */
  async run(
    move: ((libraryKey: string) => Promise<boolean>) | null,
    deps: { fetchImpl?: typeof fetch; join?: Joiner } = {},
  ): Promise<void> {
    const request = this.request;
    if (!request || this.phase === 'working' || this.phase === 'done') return;
    this.phase = 'working';
    this.problem = null;
    if (!this.library) {
      if (links.current) {
        this.library = 'kept';
      } else {
        if (!this.key) {
          // The chunk can fail to load (offline, or a release removed it): a retry can help, as with `unreachable`.
          let join = deps.join;
          if (!join) {
            try {
              ({ join } = await import('./pairJoin'));
            } catch {
              this.fail(JOIN_PROBLEMS.unreachable.text, true);
              return;
            }
          }
          const joined = await join(request.code, {
            label: thisDevice.name,
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          });
          if ('error' in joined) {
            const problem = JOIN_PROBLEMS[joined.error];
            this.fail(problem.text, !problem.final);
            return;
          }
          this.key = btoa(String.fromCharCode(...joined.handover.libraryKey));
        }
        if (!move || !(await move(this.key))) {
          this.fail(
            'Couldn’t bring your library to this phone. Check your connection and try again.',
            true,
          );
          return;
        }
        links.addRecovered(this.key, { name: 'your library', guest: true });
        this.key = null;
        this.library = 'joined';
      }
    }
    if (!request.ticket) {
      this.addons = 'none';
    } else {
      const result = await guestGrants.redeemTicket(request.ticket, deps.fetchImpl);
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
          true,
        );
        return;
      }
    }
    this.phase = 'done';
    this.forget();
  }

  private fail(problem: string, retryable: boolean): void {
    this.problem = problem;
    this.retryable = retryable;
    this.phase = 'failed';
    if (!retryable) this.forget();
  }
}

export const phoneLanding = new PhoneLanding();
