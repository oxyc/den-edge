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
});
