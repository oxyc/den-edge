import { describe, expect, it } from 'vitest';
import type { DownloadState } from './downloadQueue.svelte';
import { homeRow } from './downloadStatus';
import type { Download } from './downloadRows';

/** A minimal live row — `homeRow` never reads anything beyond `name`, so the rest is filler. */
function download(name: string): Download {
  return {
    name,
    content: name,
    release: { identity: name, label: name, url: `/scout/p/${name}` },
    title: { mediaType: 'movie', mediaId: 1, title: name },
    queuedAt: 0,
    queuedBy: 'aaaaaaaaaaaaaaaa',
    tried: [],
    exhausted: false,
    announced: false,
    reported: false,
    reannounced: false,
    row: { kind: 'set', schema: 2, name: `download:${name}`, values: {} },
    seq: 0,
  };
}

function state(state: DownloadState['state']): DownloadState {
  return {
    state,
    clock: { lastProgress: 0, progressAt: 0 },
    stalled: false,
    reannounce: false,
    write_progress: false,
    report: false,
    announce: false,
  };
}

describe('homeRow', () => {
  it('reads "Downloads", not "Downloading", when every row is ready', () => {
    const row = homeRow([
      { download: download('a'), status: state('ready') },
      { download: download('b'), status: state('ready') },
    ]);
    expect(row.heading).toBe('Downloads');
    expect(row.downloads.map((d) => d.name)).toEqual(['a', 'b']);
  });

  it('orders in-flight downloads before ready ones, and reads "Downloading"', () => {
    const row = homeRow([
      { download: download('ready-one'), status: state('ready') },
      { download: download('fetching-one'), status: state('fetching') },
      { download: download('starting-one'), status: state('starting') },
    ]);
    expect(row.heading).toBe('Downloading');
    expect(row.downloads.map((d) => d.name)).toEqual(['fetching-one', 'starting-one', 'ready-one']);
  });

  it('hides failed and no-working-release rows — they stay on /downloads, never on Home', () => {
    const row = homeRow([
      { download: download('refused'), status: state('refused') },
      { download: download('no-working-release'), status: state('no_working_release') },
      { download: download('gone'), status: state('release_gone') },
    ]);
    expect(row.downloads).toEqual([]);
  });

  it('is empty — and so hidden — with nothing in flight or ready', () => {
    expect(homeRow([]).downloads).toEqual([]);
  });
});
