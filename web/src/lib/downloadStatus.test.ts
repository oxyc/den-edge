import { expect, it } from 'vitest';
import { headline, isTrouble, phase, stateLabel } from './downloadStatus';
import { inFlight, type DownloadState } from './downloadQueue.svelte';
import type { Preparation } from './titleSources';

/** A DownloadState with just the fields a test cares about; the rest are den_core bookkeeping. */
function status(state: DownloadState['state'], extra: Partial<DownloadState> = {}): DownloadState {
  return {
    state,
    clock: { lastProgress: 0, progressAt: 0 },
    stalled: false,
    reannounce: false,
    write_progress: false,
    report: false,
    announce: false,
    ...extra,
  };
}

// den-scout now reports a release parked behind the debrid's own slot limit (TorBox's queue, not a
// torrent yet) as `fetch.state: 'queued'` — on the initial createtorrent success path, and (den#226) on
// the DIFF_ISSUE "already queued" and status-poll paths too. den_core's `download_status` buckets any
// `preparing` answer as the `fetching` state regardless of which debrid sub-state it carries, so this is
// what turns that into Home/the Downloads page showing "Queued at TorBox" and counting it as in flight —
// the two things that silently broke when scout reported the release as dead or not_queued instead.
it('shows "Queued at <service>" for a release parked in the debrid\'s own queue, and counts it in flight', () => {
  const queued: Preparation = { state: 'preparing', fetch: { state: 'queued', service: 'torbox' } };
  expect(headline(status('fetching'), queued)).toBe('Queued at TorBox');
  expect(inFlight('fetching')).toBe(true);
  expect(isTrouble(status('fetching'), queued)).toBe(false);
  expect(phase(status('fetching'), queued)).toBe('downloading');
});

it('falls back to the raw service id when it is not one of the known debrids', () => {
  const queued: Preparation = {
    state: 'preparing',
    fetch: { state: 'queued', service: 'newdebrid' },
  };
  expect(headline(status('fetching'), queued)).toBe('Queued at newdebrid');
});

it('still reports the plain state label once nothing more specific applies', () => {
  expect(stateLabel(status('starting'))).toBe('Starting…');
  expect(stateLabel(status('ready'))).toBe('Ready to play');
  expect(stateLabel(status('paused'))).toBe('Paused');
});
