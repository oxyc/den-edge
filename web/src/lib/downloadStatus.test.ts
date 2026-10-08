import { describe, expect, it } from 'vitest';
import { viewFacts, viewHeadline, viewTrouble } from './downloadStatus';
import type { DownloadViewItem } from './libraryServiceProtocol';

const item = (status: Partial<DownloadViewItem['status']>): DownloadViewItem => ({
  content: 'movie:1:-1:-1',
  title: { type: 'movie', id: 1 },
  name: 'One',
  queuedAt: 1,
  queuedBy: { device: 'self', isSelf: true },
  release: { identity: 'one', label: 'One' },
  status: { state: 'fetching', phase: 'downloading', stalled: false, ...status },
  tried: 1,
  announced: false,
});

describe('download view presentation', () => {
  it('formats sanitized service progress', () => {
    const download = item({ fraction: 0.42, etaSeconds: 90, bytesPerSecond: 4_000_000 });
    expect(viewHeadline(download)).toBe('Downloading 42%');
    expect(viewFacts(download)).toEqual(['4.0 MB/s', '2 min left']);
  });

  it('uses the semantic trouble phase', () => {
    expect(viewTrouble(item({ state: 'unreachable', phase: 'trouble' }))).toBe(true);
  });

  it('names live dead and stalled states instead of presenting them as downloading', () => {
    expect(viewHeadline(item({ fetch: { state: 'failed' }, phase: 'trouble' }))).toBe(
      'Download failed',
    );
    expect(
      viewHeadline(item({ fetch: { state: 'stalled' }, phase: 'trouble', stalled: true })),
    ).toBe('Download stalled');
  });

  it('shows normalized service, pause, and attempts while rejecting implausible ETAs', () => {
    const download = item({
      state: 'paused',
      phase: 'queued',
      service: 'Real-Debrid',
      until: 180_001,
      etaSeconds: 9_999_999,
    });
    download.tried = 3;
    download.candidates = 5;
    expect(viewFacts(download, 1)).toEqual(['Real-Debrid', 'Retries in 3 min', 'Tried 3 of 5']);
  });
});
