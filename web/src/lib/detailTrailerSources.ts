import type { LogicalSource } from './reel';

/** LG's native HLS pipeline is preferred, while progressive sources remain ordered fallbacks. */
export function nativeHlsFirst(sources: LogicalSource[]): LogicalSource[] {
  return [
    ...sources.filter((source) => source.kind === 'hls'),
    ...sources.filter((source) => source.kind !== 'hls'),
  ];
}
