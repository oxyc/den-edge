/**
 * Calls `onStuck` once `ms` pass with nothing to show for them: `progress()` — bytes arriving — starts the wait over.
 * A browser that can't decode what it was sent fetches it and shows nothing; a slow link shows nothing either, but its
 * bytes keep coming, and taking that for a refusal asks for a transcode the link didn't need.
 */
export function stuckWatch(
  ms: number,
  onStuck: () => void,
  timers: { set: typeof setTimeout; clear: typeof clearTimeout } = {
    set: setTimeout,
    clear: clearTimeout,
  },
): { progress(): void; stop(): void } {
  let stopped = false;
  let timer = timers.set(onStuck, ms);
  return {
    progress() {
      if (stopped) return;
      timers.clear(timer);
      timer = timers.set(onStuck, ms);
    },
    stop() {
      stopped = true;
      timers.clear(timer);
    },
  };
}
