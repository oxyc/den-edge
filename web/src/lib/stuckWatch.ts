/**
 * Calls `onStuck` once `ms` pass with nothing to show for them. Bytes arriving start the wait over: `progress()` says
 * some did, and `arrived()`, asked when the wait runs out, says how many have by then — a fragment still loading counts
 * as it comes in, so a slow link's long download is progress too. A request merely starting is not. A browser that
 * can't decode what it was sent fetches it and shows nothing; a slow link shows nothing either, but its bytes keep
 * coming, and taking that for a refusal would move the viewer off a release that plays.
 */
export function stuckWatch(
  ms: number,
  onStuck: () => void,
  arrived: () => number = () => 0,
): { progress(): void; stop(): void } {
  let stopped = false;
  let seen = arrived();
  const due = () => {
    const now = arrived();
    if (now > seen) {
      seen = now;
      timer = setTimeout(due, ms);
      return;
    }
    onStuck();
  };
  let timer = setTimeout(due, ms);
  return {
    progress() {
      if (stopped) return;
      seen = arrived();
      clearTimeout(timer);
      timer = setTimeout(due, ms);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
