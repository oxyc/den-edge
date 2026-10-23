import { describe, expect, it } from 'vitest';
import type { LogicalSource } from './reel';
import { nativeHlsFirst } from './detailTrailerSources';

const source = (kind: LogicalSource['kind'], name: string): LogicalSource => ({
  kind,
  audio: true,
  width: kind === 'mp4' ? 1280 : null,
  height: kind === 'mp4' ? 720 : null,
  delivery: { type: 'external', url: `https://video.example/${name}` },
});

describe('detail trailer source order', () => {
  it('puts native HLS first without discarding or reordering progressive fallbacks', () => {
    const first = source('mp4', 'first.mp4');
    const native = source('hls', 'native.m3u8');
    const last = source('mp4', 'last.mp4');

    expect(nativeHlsFirst([first, native, last])).toEqual([native, first, last]);
  });
});
