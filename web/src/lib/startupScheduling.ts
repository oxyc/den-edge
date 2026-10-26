import { startupMilestone } from './startupTiming';

type Milestone = (event: string) => number | undefined;
type Timer = (task: () => void, milliseconds: number) => unknown;

/** Admit optional startup work only after useful content, while never deadlocking an empty or failed surface. */
export function scheduleAfterStartupMilestone(
  task: () => void,
  events: readonly string[],
  {
    timeoutMs = 5_000,
    delayMs = 1_000,
    fallbackDelayMs = delayMs,
    pollMs = 250,
  }: { timeoutMs?: number; delayMs?: number; fallbackDelayMs?: number; pollMs?: number } = {},
  milestone: Milestone = startupMilestone,
  now: () => number = () => performance.now(),
  later: Timer = (next, milliseconds) => setTimeout(next, milliseconds),
): void {
  const waitingSince = now();
  const afterFirstContent = () => {
    if (events.some((event) => milestone(event) !== undefined)) {
      later(task, delayMs);
      return;
    }
    if (now() - waitingSince >= timeoutMs) {
      later(task, fallbackDelayMs);
      return;
    }
    later(afterFirstContent, pollMs);
  };
  afterFirstContent();
}
