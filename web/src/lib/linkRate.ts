// How fast a link delivered den-remux's `/speed`, from its chunks as they arrived. No imports: the cast receiver, a
// separate keyless origin, times its signed probe with the same rule.

/**
 * The bytes a link is timed over: den-remux's most (`/remux/speed` sends 8 MiB at most). On a long path the whole of
 * a smaller probe is a connection's slow start, which times the round trip rather than the link.
 */
export const SPEED_PROBE_BYTES = 8 * 1024 * 1024;
/**
 * The start of the transfer that isn't counted, by bytes rather than time: slow start doubles the window once a round
 * trip, so on a 250 ms path a time-based skip ends long before it does, while a link of tens of Mbit/s leaves it within
 * about its first megabyte.
 */
const SPEED_SKIP_BYTES = 1024 * 1024;
/** The span each rate in the counted tail is taken over; the link is the best of them. */
const SPEED_WINDOW_MS = 1_000;

/**
 * The bits a second a transfer shows the link carries, from its chunks as they arrived (`[ms, bytes]`). The first
 * SPEED_SKIP_BYTES are slow start and aren't counted; past them it is the most any SPEED_WINDOW_MS delivered — a
 * window, not the whole tail, because a pause in the tail (another tab, the radio) is not what the link can do. A tail
 * shorter than a window counts whole, and a transfer that never got past the skip is timed over all of it. Each rate
 * counts the bytes after the chunk it is timed from, whose own arrival is the start. Null for less than two chunks.
 */
export function linkRate(chunks: readonly (readonly [ms: number, bytes: number])[]): number | null {
  const rate = (from: number, to: number) => {
    const ms = chunks[to]![0] - chunks[from]![0];
    let bytes = 0;
    for (let i = from + 1; i <= to; i++) bytes += chunks[i]![1];
    return ms > 0 ? (bytes * 8000) / ms : null;
  };
  const last = chunks.length - 1;
  if (last < 1) return null;
  let skipped = 0;
  let mark = 0;
  while (mark < last && (skipped += chunks[mark]![1]) < SPEED_SKIP_BYTES) mark++;
  if (mark >= last) return rate(0, last);
  let best: number | null = null;
  for (let from = mark, to = mark; from < last; from++) {
    while (to < last && chunks[to]![0] - chunks[from]![0] < SPEED_WINDOW_MS) to++;
    if (chunks[to]![0] - chunks[from]![0] < SPEED_WINDOW_MS) break;
    const r = rate(from, to);
    if (r !== null && (best === null || r > best)) best = r;
  }
  return best ?? rate(mark, last);
}
