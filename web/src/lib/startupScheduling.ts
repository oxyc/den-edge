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
    pollMs = 250,
  }: { timeoutMs?: number; delayMs?: number; pollMs?: number } = {},
  milestone: Milestone = startupMilestone,
  now: () => number = () => performance.now(),
  later: Timer = (next, milliseconds) => setTimeout(next, milliseconds),
): void {
  const waitingSince = now();
  const afterFirstContent = () => {
    if (events.some((event) => milestone(event) !== undefined) || now() - waitingSince >= timeoutMs)
      later(task, delayMs);
    else later(afterFirstContent, pollMs);
  };
  afterFirstContent();
}
